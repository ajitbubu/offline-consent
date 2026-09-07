"""
Reading the handwritten fields without a trained model.

The received wisdom is that pulling a name off a scanned form needs layout
classification, which needs a labelled corpus, which does not exist yet. That is
true for an arbitrary document. It is NOT true for a consent form, and the
reason is the same one that makes tick-box reading work from the first scan:

    the form labels its own fields, in print, and printed text is what OCR is
    reliably good at.

        Full name:   Priya Sharma
        ^^^^^^^^^^   ^
        anchor       the value is to the right, on the same line

So the machinery is `tickbox.find_anchor` pointed sideways. Locate the printed
label, then read the tokens in the band to its right. No training, no corpus, no
waiting for fifty forms.

WHAT THIS DOES NOT DO. It cannot read a form that does not print its field
labels, or one where the value sits somewhere unrelated to them. That is the job
the layout model still has, and it is why banking `(tokens, human payload)` pairs
stays worth doing even though this works today. This handles the common case now;
the model handles the rest later.

THREE KINDS OF FIELD, TWO STRATEGIES.

`email` and `phone` are SELF-IDENTIFYING: a string containing an @ is an email
wherever it appears on the page, and eleven digits in a row are a phone number
whatever the label above them says. Those are matched by pattern over the whole
token stream, which is more robust than anchoring because it survives a label
that OCR mangled.

`text` and `date` are not self-identifying - "Priya Sharma" is only a name
because of what is printed to its left - so those are read by anchor.

NEVER GUESS. Every function here returns None rather than a low-confidence
value, and the app renders a null exactly like an empty field. This mirrors
`granted: null` on a tick-box: a failed read and a confirmed blank are different
facts, and collapsing them would put words in a person's mouth. A wrong
pre-filled name is worse than an empty one, because reviewers stop checking
things that are usually right.
"""

from __future__ import annotations

import re

from app.contract import FieldRequest, FieldResult, Page, Token
from app.tickbox import find_anchor

# Below this the printed label was not really found, so anything read beside it
# would be a reading of an arbitrary patch of paper. Matches tickbox.py.
MIN_ANCHOR_SCORE = 0.62

# How far right of the label to read, as a fraction of PAGE WIDTH.
#
# Not a multiple of the label's height, which was the first attempt and the
# wrong abstraction: the anchor box is the tight glyph bounds, so a 34px font
# measures about 25px, and a perfectly ordinary column gap of 320px came out as
# 13x "height" and was rejected. Form layout scales with the page, not with the
# type size, so the page is what these are measured against.
READ_RIGHT_SPAN = 0.6

# A token counts as being on the same line when its vertical centre sits within
# this fraction of the anchor's height from the anchor's centre.
SAME_LINE_TOLERANCE = 0.6

# Two different gaps, and conflating them was a real bug.
#
# The gap between the LABEL and the value it introduces is often large, because
# forms are laid out in columns: "Full name:" sits at x=140 and the value at
# x=470, whatever the label's own width. Measuring that gap with the same
# tolerance used between words meant the reader stopped before it ever reached
# the value, and every name on a columnar form came back null at 0.00
# confidence - on the fixture it worked only because the label and value were
# drawn as one string.
#
# The gap WITHIN a value stays tight: once reading has started, a wide run of
# whitespace really does mean the next field.
FIRST_GAP_LIMIT = 0.35
VALUE_GAP_LIMIT = 2.2

# An email is unambiguous enough to trust on sight.
#
# The character classes are explicit rather than "anything but a space", and
# that is not pedantry: OCR picks up the rule a value is written on as a dash
# glued to the front of the token, and a permissive local part swallows it -
# turning a clean address into "—priya.sharma@example.org", which then fails
# normalisation in the app for a reason nobody could see from the scan.
_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")

# Indian mobiles are ten digits; allow an optional country code and the
# separators people write. Validation proper happens in the app, which already
# owns normalisePhone - this only has to FIND the candidate.
_PHONE_DIGITS = re.compile(r"\d")
_MIN_PHONE_DIGITS = 10
_MAX_PHONE_DIGITS = 13

# Tokens that are punctuation left over from a label ("Name :") or the rule a
# value is written on. Dropping them stops a value reading as ": Priya".
_STRIP_EDGE = re.compile(r"^[\s:;.,\-_/\\|]+|[\s:;.,\-_/\\|]+$")


def _height(box: tuple[int, int, int, int]) -> int:
    return max(1, box[3] - box[1])


def _centre_y(box: tuple[int, int, int, int]) -> float:
    return (box[1] + box[3]) / 2


def _clean(text: str) -> str:
    return _STRIP_EDGE.sub("", text).strip()


def _mean_confidence(tokens: list[Token]) -> float:
    return sum(t.confidence for t in tokens) / len(tokens) if tokens else 0.0


def _digits(text: str) -> str:
    return "".join(_PHONE_DIGITS.findall(text))


def _read_right(page: Page, anchor: tuple[int, int, int, int]) -> list[Token]:
    """Tokens sitting to the right of `anchor` on the same line.

    Stops at the first wide gap. A form separates one field from the next with
    whitespace, so a gap is a boundary rather than a space - without this,
    "Full name: Priya Sharma    Mobile: 98765" reads as one very long name.
    """
    height = _height(anchor)
    centre = _centre_y(anchor)
    limit_x = anchor[2] + page.width * READ_RIGHT_SPAN

    candidates = [
        t
        for t in page.tokens
        if t.bbox[0] >= anchor[2]
        and t.bbox[0] <= limit_x
        and abs(_centre_y(t.bbox) - centre) <= height * SAME_LINE_TOLERANCE
    ]
    candidates.sort(key=lambda t: t.bbox[0])

    out: list[Token] = []
    previous_right = anchor[2]
    for token in candidates:
        # The label-to-value gap is measured against the page; the gap between
        # words of a value is measured against the type size.
        gap = token.bbox[0] - previous_right
        limit = height * VALUE_GAP_LIMIT if out else page.width * FIRST_GAP_LIMIT
        if gap > limit:
            break
        # A token that is itself a label ends the value. On a two-column form
        # the next field sits on the same line to the right, and a generous
        # first gap would otherwise read "Priya Sharma Mobile 98765" as a name.
        if _looks_like_label(token.text) or _looks_like_instruction(token.text):
            break
        out.append(token)
        previous_right = token.bbox[2]
    return out


def _looks_like_label(text: str) -> bool:
    """A printed field label rather than a handwritten value.

    Forms punctuate their labels; people do not punctuate their names. This is
    what keeps a value from running into the next column of a two-column form.
    """
    stripped = text.strip()
    return stripped.endswith(":") and len(stripped) > 1


def _plausible_phone(text: str) -> bool:
    """Enough digits to be a number somebody could be called on."""
    return _MIN_PHONE_DIGITS <= len(_digits(text)) <= _MAX_PHONE_DIGITS


def _looks_like_instruction(text: str) -> bool:
    """Printed guidance rather than something a person wrote.

    Found by running this over 146 real Indian bank forms. Beside "Mobile No."
    the SBI account-opening form prints "(Mandatory for CKYC update request)",
    and the reader happily returned it as a phone number with anchor 1.00 -
    the label WAS found, so nothing looked wrong from the outside.

    Parentheses are the tell. A form uses them constantly for instructions; a
    person filling one in does not write their name in brackets.
    """
    stripped = text.strip()
    return stripped.startswith("(") or stripped.startswith("[")


def _span_box(tokens: list[Token]) -> tuple[int, int, int, int] | None:
    if not tokens:
        return None
    return (
        min(t.bbox[0] for t in tokens),
        min(t.bbox[1] for t in tokens),
        max(t.bbox[2] for t in tokens),
        max(t.bbox[3] for t in tokens),
    )


# A label that is punctuated is a field; the same words inside a sentence are
# prose. Worth this much on the match score - enough to win a tie, not enough to
# beat a genuinely better match.
LABEL_PUNCTUATION_BONUS = 0.15


def _label_bonus(tokens: list[Token], end_index: int) -> float:
    """Does this match look like a field label rather than words in a sentence?

    Found against the SBI account-opening form, which prints the section header
    "(All communications will be sent on provided Mobile No./Email-ID)". The
    words "Mobile No" appear there in prose and matched at 1.00, so the reader
    anchored on a sentence and returned "./Email-ID)" as the phone number.

    A real field label is punctuated - it ends with a colon, or carries the
    asterisk Indian bank forms use for "mandatory". Prose is not.
    """
    if end_index < len(tokens):
        following = tokens[end_index].text.strip()
        if following.startswith(":") or following.startswith("*"):
            return LABEL_PUNCTUATION_BONUS
    if end_index - 1 >= 0:
        last = tokens[end_index - 1].text.strip()
        if last.endswith(":") or last.endswith("*:") or last.endswith("*"):
            return LABEL_PUNCTUATION_BONUS

    # Matched INSIDE a phrase, not at the end of a label. The SBI form's
    # section header reads "...sent on provided Mobile No./Email-ID)", where
    # "Mobile No" is followed by "./Email-ID)" - a continuation, not a value.
    # Without this the prose ties with the real "Mobile No." field label and
    # wins by scan order.
    if end_index < len(tokens):
        following = tokens[end_index].text.strip()
        if following[:1] in (".", "/", ")", ",", ";"):
            return -LABEL_PUNCTUATION_BONUS
    return 0.0


def _best_anchor(
    pages: list[Page], labels: list[str]
) -> tuple[float, Page | None, tuple[int, int, int, int] | None]:
    """The strongest match for any of `labels`, across every page.

    Ties are broken toward the WIDER match, and that is not cosmetic. Asked for
    both "Mobile" and "Mobile No" against a form printing "Mobile No:", both
    score 1.000 - and taking the first meant anchoring on the bare word
    "Mobile". The very next token is then "No:", which reads as the next field's
    label and ends the value before it starts, so the field came back empty and
    fell through to a page-wide digit scan that returned the applicant's
    twelve-digit Aadhaar number as their phone.
    A tie between a prefix and the whole label is not really a tie.
    """
    best_score = 0.0
    best_width = -1
    best_page: Page | None = None
    best_box: tuple[int, int, int, int] | None = None

    for page in pages:
        for label in labels:
            score, box = find_anchor(page.tokens, label, _label_bonus)
            if box is None:
                continue
            width = box[2] - box[0]
            if (score, width) > (best_score, best_width):
                best_score, best_width, best_page, best_box = score, width, page, box

    return best_score, best_page, best_box


def _find_email(pages: list[Page]) -> FieldResult | None:
    """An address anywhere on the page. Self-identifying, so no anchor needed."""
    for page in pages:
        for index, token in enumerate(page.tokens):
            match = _EMAIL.search(token.text)
            if match:
                return FieldResult(
                    key="",
                    value=match.group(0).lower(),
                    confidence=token.confidence,
                    anchor_score=1.0,
                    method="pattern",
                    page=page.page,
                    bbox=token.bbox,
                )
            # OCR sometimes splits on the @, so try joining with the neighbour.
            if index + 1 < len(page.tokens):
                joined = token.text + page.tokens[index + 1].text
                match = _EMAIL.search(joined)
                if match:
                    pair = [token, page.tokens[index + 1]]
                    return FieldResult(
                        key="",
                        value=match.group(0).lower(),
                        confidence=_mean_confidence(pair),
                        anchor_score=1.0,
                        method="pattern",
                        page=page.page,
                        bbox=_span_box(pair),
                    )
    return None


def _find_phone(pages: list[Page]) -> FieldResult | None:
    """A run of 10-13 digits, possibly split across tokens.

    Deliberately permissive about shape and silent about validity: E.164
    normalisation lives in the app, which refuses a number it cannot place and
    blocks the commit. Guessing harder here would only move that decision
    somewhere it cannot be enforced.
    """
    for page in pages:
        tokens = page.tokens
        for start in range(len(tokens)):
            run: list[Token] = []
            digits = ""
            for token in tokens[start : start + 4]:
                # A token with letters in it is not part of a phone number.
                if any(c.isalpha() for c in token.text):
                    break
                run.append(token)
                digits += _digits(token.text)
                if len(digits) > _MAX_PHONE_DIGITS:
                    break
                if _MIN_PHONE_DIGITS <= len(digits) <= _MAX_PHONE_DIGITS:
                    return FieldResult(
                        key="",
                        value=" ".join(_clean(t.text) for t in run).strip(),
                        confidence=_mean_confidence(run),
                        anchor_score=1.0,
                        method="pattern",
                        page=page.page,
                        bbox=_span_box(run),
                    )
    return None


def _read_anchored(pages: list[Page], request: FieldRequest) -> FieldResult:
    """Locate the printed label, read the value beside it."""
    score, page, box = _best_anchor(pages, request.labels)

    if page is None or box is None or score < MIN_ANCHOR_SCORE:
        return FieldResult(
            key=request.key, value=None, confidence=0.0, anchor_score=score, method=None
        )

    tokens = _read_right(page, box)
    value = _clean(" ".join(t.text for t in tokens))

    if not value:
        # The label was found and there was nothing beside it. That is a blank
        # field on the paper, which is a real answer - but it is reported as a
        # null value with a good anchor score, so the app can tell the two
        # apart if it ever wants to.
        return FieldResult(
            key=request.key,
            value=None,
            confidence=0.0,
            anchor_score=score,
            method="anchored",
            page=page.page,
            bbox=box,
        )

    # The value is only as trustworthy as the weaker of two things: how sure we
    # are that we found the right label, and how sure OCR is of the characters.
    confidence = min(score, _mean_confidence(tokens))

    return FieldResult(
        key=request.key,
        value=value,
        confidence=confidence,
        anchor_score=score,
        method="anchored",
        page=page.page,
        bbox=_span_box(tokens),
    )


def read(pages: list[Page], requests: list[FieldRequest]) -> list[FieldResult]:
    """One result per request, in the order asked for.

    A request always produces a result, even a failed one. Silence would be
    indistinguishable from the app forgetting to ask.
    """
    results: list[FieldResult] = []

    for request in requests:
        if request.kind == "email":
            # An address is self-identifying: an @ is an @ wherever it sits, so
            # the pattern is more reliable than a label OCR may have mangled.
            found = _find_email(pages)
            if found is not None:
                results.append(found.model_copy(update={"key": request.key}))
                continue
            results.append(_read_anchored(pages, request))
            continue

        if request.kind == "phone":
            # A phone number is NOT self-identifying, and treating it as one was
            # a real bug. `_find_phone` returns the first 10-13 digit run on the
            # page - and an Aadhaar number is TWELVE digits. On an Indian form
            # that carries both, a page-wide scan hands back the Aadhaar as the
            # applicant's phone, at anchor_score 1.0, and it is then stored as a
            # contact point. Wrong field, and the most sensitive identifier on
            # the paper.
            #
            # So the printed label leads, exactly as it does for a name. The
            # page-wide scan stays, but only as a FALLBACK for a form whose
            # label OCR could not read - and even then it is what it always was:
            # a suggestion a human confirms.
            anchored = _read_anchored(pages, request)
            if anchored.value and _plausible_phone(anchored.value):
                results.append(anchored)
                continue
            found = _find_phone(pages)
            if found is not None:
                results.append(found.model_copy(update={"key": request.key}))
                continue
            results.append(anchored)
            continue

        results.append(_read_anchored(pages, request))

    return results


__all__ = ["read", "MIN_ANCHOR_SCORE"]
