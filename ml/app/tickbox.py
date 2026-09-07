"""
Reading tick-boxes without a trained model.

The trick is that a consent form already tells us where to look. Every purpose
on a notice version carries the exact wording printed beside its box
(`consent_notice_purpose.printed_label`, which is why that column has a trigram
index). Printed text is what OCR is reliably good at - so we locate the LABEL,
and the box is in a known place relative to it.

    +---+
    | X |  I agree to receive marketing communications
    +---+  ^
      ^    anchor: found by fuzzy-matching the printed label
      |
      search band: left of the anchor, one line-height tall

That is why tick-box reading works from the first form while text extraction has
to wait for a corpus. Nothing here is learned.

CALIBRATION. `INK_THRESHOLD` below is a starting value, not a tuned one. Ink
density depends on scan quality, and a faint pencil tick on a heavy scan sits
close to an empty box with a dark border. `ink_ratio` is returned on every result
precisely so the threshold can be set from real forms rather than from this
comment. Until it has been, treat every reading as a suggestion for a human -
which is what the review screen does with it anyway.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from difflib import SequenceMatcher

import numpy as np
from PIL import Image

from app.contract import Page, TickBoxRequest, TickBoxResult, Token

# Below this, we did not really find the label, and anything read underneath it
# would be a reading of an arbitrary patch of paper.
MIN_ANCHOR_SCORE = 0.62

# Fraction of the box INTERIOR that must be dark to count as ticked.
INK_THRESHOLD = 0.08

# How far left of the label to look, in multiples of the label's line height.
SEARCH_LEFT_SPAN = 4.0
SEARCH_LEFT_GAP = 0.1

# The border of an empty box is ink too, so the interior is measured with the
# outer margin cropped away. This only works if the crop is aligned to the box
# itself - see _locate_box.
BORDER_INSET = 0.28

# A located box has to be plausibly box-shaped. Anything longer than this in
# either direction, relative to the label's line height, is a rule, an underline
# or the edge of a table cell rather than a tick-box.
MIN_BOX_SIDE = 0.4
MAX_BOX_SIDE = 2.4

_PUNCT = re.compile(r"[^\w\s]+", re.UNICODE)
_SPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    return _SPACE.sub(" ", _PUNCT.sub(" ", text.lower())).strip()


def _score(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def find_anchors(
    tokens: list[Token],
    label: str,
    limit: int = 8,
    bonus: Callable[[list[Token], int], float] | None = None,
) -> list[tuple[float, tuple[int, int, int, int], int]]:
    """Every plausible match for `label`, best first, as (score, box, end_index).

    `find_anchor` returns only the winner, which is the right shape when the
    only evidence is the text. It is the wrong shape when something ELSE on the
    page can break the tie - and on a form something can: whether a place to
    write follows. The SBI account-opening form says "Name" twice, once as the
    field and once inside "Bank/Branch to affix rubber stamp of name and code
    no.", and both score 1.00. Text alone cannot choose; the comb boxes beside
    one of them can.

    So candidates are returned and the caller decides. Non-overlapping only, so
    eight candidates are eight different places on the page rather than eight
    framings of the same words.
    """
    target = normalise(label)
    if not target or not tokens:
        return []

    words = target.split()
    widths = {max(1, len(words) + delta) for delta in (-2, -1, 0, 1, 2)}

    scored: list[tuple[float, tuple[int, int, int, int], int]] = []
    for width in sorted(widths):
        for start in range(0, max(1, len(tokens) - width + 1)):
            window = tokens[start : start + width]
            if not window:
                continue
            candidate = normalise(" ".join(t.text for t in window))
            if not candidate:
                continue
            score = _score(target, candidate)
            if bonus is not None:
                score += bonus(tokens, start + width)
            box = (
                min(t.bbox[0] for t in window),
                min(t.bbox[1] for t in window),
                max(t.bbox[2] for t in window),
                max(t.bbox[3] for t in window),
            )
            scored.append((min(score, 1.0), box, start + width))

    scored.sort(key=lambda c: (-c[0], -(c[1][2] - c[1][0])))

    kept: list[tuple[float, tuple[int, int, int, int], int]] = []
    for score, box, end in scored:
        if any(_overlaps(box, k[1]) for k in kept):
            continue
        kept.append((score, box, end))
        if len(kept) >= limit:
            break
    return kept


def _overlaps(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def find_anchor(
    tokens: list[Token],
    label: str,
    bonus: Callable[[list[Token], int], float] | None = None,
) -> tuple[float, tuple[int, int, int, int] | None]:
    """Best fuzzy match for `label` in the token stream, and its bounding box.

    `bonus` lets a caller prefer matches that look like a printed FIELD LABEL
    over the same words appearing inside a sentence. fields.py had this as a
    private fork of this function, which meant the fix only ever reached field
    reading: the SBI form prints "...sent on provided Mobile No./Email-ID)" as a
    section header, and tick-box anchoring still scored prose at 1.00 here while
    field anchoring had learned not to. One implementation, one behaviour.
    """
    target = normalise(label)
    if not target or not tokens:
        return 0.0, None

    words = target.split()
    # OCR splits and merges words, so try windows a little either side of the
    # label's own word count rather than trusting it exactly.
    widths = {max(1, len(words) + delta) for delta in (-2, -1, 0, 1, 2)}

    best_score = 0.0
    best_box: tuple[int, int, int, int] | None = None

    for width in sorted(widths):
        for start in range(0, max(1, len(tokens) - width + 1)):
            window = tokens[start : start + width]
            if not window:
                continue
            candidate = normalise(" ".join(t.text for t in window))
            if not candidate:
                continue
            score = _score(target, candidate)
            if bonus is not None:
                score += bonus(tokens, start + width)
            if score > best_score:
                best_score = score
                best_box = (
                    min(t.bbox[0] for t in window),
                    min(t.bbox[1] for t in window),
                    max(t.bbox[2] for t in window),
                    max(t.bbox[3] for t in window),
                )

    # A bonus must never let a mediocre match report itself as perfect.
    return min(best_score, 1.0), best_box


def _ink_mask(image: Image.Image, box: tuple[int, int, int, int], background: float) -> np.ndarray:
    """Boolean mask of pixels meaningfully darker than the paper.

    The paper level is derived per page rather than assumed to be 255, so a grey
    or yellowed scan does not read as entirely inked.
    """
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return np.zeros((0, 0), dtype=bool)
    crop = np.asarray(image.crop((x0, y0, x1, y1)), dtype=np.float32)
    return crop < background * 0.75


def _locate_box(
    image: Image.Image,
    band: tuple[int, int, int, int],
    background: float,
) -> tuple[int, int, int, int] | None:
    """The tick-box itself, found from the ink in the search band.

    Sliding a fixed window across the band and taking whichever position held the
    most ink does NOT work: the window drifts off the box, catches the border in
    what it treats as the interior, and an empty box reads as ticked. The band is
    narrow enough to contain the box and little else, so the bounding box of the
    ink in it IS the box - and cropping relative to that is aligned by
    construction.
    """
    mask = _ink_mask(image, band, background)
    if mask.size == 0 or not mask.any():
        return None

    # The band's right edge sits just short of the label, and OCR's idea of
    # where the label starts is a glyph or two optimistic - so the band usually
    # clips the first letter. Taking the bounding box of ALL ink would then
    # stretch the "box" across the gap to include that letter, and the interior
    # crop would land between the two on blank paper.
    #
    # The box and the text are separated by whitespace, so split the ink into
    # column runs and keep the leftmost: that is the box, whatever else the band
    # caught.
    columns = mask.any(axis=0)
    gap = max(2, int(mask.shape[0] * 0.25))
    runs: list[tuple[int, int]] = []
    start: int | None = None
    blank = 0
    for x, inked in enumerate(columns):
        if inked:
            if start is None:
                start = x
            blank = 0
        elif start is not None:
            blank += 1
            if blank >= gap:
                runs.append((start, x - blank + 1))
                start = None
    if start is not None:
        runs.append((start, len(columns)))
    if not runs:
        return None

    cx0, cx1 = runs[0]
    rows = np.flatnonzero(mask[:, cx0:cx1].any(axis=1))
    if rows.size == 0:
        return None

    return (
        band[0] + cx0,
        band[1] + int(rows[0]),
        band[0] + cx1,
        band[1] + int(rows[-1]) + 1,
    )


def _interior_ink(image: Image.Image, box: tuple[int, int, int, int], background: float) -> float:
    x0, y0, x1, y1 = box
    inset_x = int((x1 - x0) * BORDER_INSET)
    inset_y = int((y1 - y0) * BORDER_INSET)
    interior = (x0 + inset_x, y0 + inset_y, x1 - inset_x, y1 - inset_y)
    if interior[2] <= interior[0] or interior[3] <= interior[1]:
        return 0.0
    mask = _ink_mask(image, interior, background)
    return float(mask.mean()) if mask.size else 0.0


def _background(image: Image.Image) -> float:
    sample = np.asarray(image, dtype=np.float32)
    # 90th percentile is the paper, not the ink, on any page with text on it.
    return max(1.0, float(np.percentile(sample, 90)))


def read(
    pages: list[Page],
    images: dict[int, Image.Image],
    requests: list[TickBoxRequest],
) -> list[TickBoxResult]:
    backgrounds = {number: _background(image) for number, image in images.items()}
    results: list[TickBoxResult] = []

    for request in requests:
        best: TickBoxResult | None = None

        for page in pages:
            score, anchor = find_anchor(page.tokens, request.text)
            if anchor is None:
                continue
            if best is not None and score <= best.anchor_score:
                continue

            if score < MIN_ANCHOR_SCORE:
                # Record the near miss so the caller can see how close we got.
                best = TickBoxResult(
                    index=request.index, granted=None, confidence=0.0, anchor_score=score
                )
                continue

            image = images[page.page]
            ax0, ay0, _, ay1 = anchor
            line_height = max(8.0, float(ay1 - ay0))
            centre = (ay0 + ay1) / 2.0

            left = max(0, int(ax0 - SEARCH_LEFT_SPAN * line_height))
            right = max(left + 1, int(ax0 - SEARCH_LEFT_GAP * line_height))
            top = max(0, int(centre - 0.9 * line_height))
            bottom = min(page.height, int(centre + 0.9 * line_height))

            band = (left, top, right, bottom)
            best_box = _locate_box(image, band, backgrounds[page.page])

            if best_box is not None:
                # Reject anything that is not plausibly a box: a rule, an
                # underline, or the edge of a table cell.
                box_width = (best_box[2] - best_box[0]) / line_height
                box_height = (best_box[3] - best_box[1]) / line_height
                if not (
                    MIN_BOX_SIDE <= box_width <= MAX_BOX_SIDE
                    and MIN_BOX_SIDE <= box_height <= MAX_BOX_SIDE
                ):
                    best_box = None

            best_ink = (
                _interior_ink(image, best_box, backgrounds[page.page])
                if best_box is not None
                else 0.0
            )

            if best_box is None:
                best = TickBoxResult(
                    index=request.index, granted=None, confidence=0.0, anchor_score=score
                )
                continue

            granted = best_ink >= INK_THRESHOLD
            # A reading is only as good as the anchor it hangs off, and only as
            # good as its distance from the threshold it was decided by.
            decisiveness = min(1.0, abs(best_ink - INK_THRESHOLD) / INK_THRESHOLD)
            best = TickBoxResult(
                index=request.index,
                granted=granted,
                confidence=round(score * (0.5 + 0.5 * decisiveness), 4),
                page=page.page,
                bbox=best_box,
                anchor_score=round(score, 4),
                ink_ratio=round(best_ink, 4),
            )

        results.append(
            best
            or TickBoxResult(index=request.index, granted=None, confidence=0.0, anchor_score=0.0)
        )

    return results
