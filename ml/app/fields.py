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

from typing import TYPE_CHECKING

from app import regions
from app.contract import FieldRequest, FieldResult, Page, Token

if TYPE_CHECKING:  # pragma: no cover - import only for the type
    from PIL.Image import Image
from app.tickbox import find_anchor, find_anchors, normalise

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
#
# Asymmetric, because a written value sits LOWER than the label that introduces
# it and never higher. That is geometry rather than handwriting habit: the
# label's box is the tight bounds of printed x-height, while a written value
# carries ascenders and descenders, so its box is taller and its centre falls
# below. Measured on SMBC's fixed-deposit form, "Ajit Kumar Sahu" (box height
# 31) sits +19px under "Full name of the Depositor" (box height 23), and the
# next printed line is at +34.
#
# The symmetric 0.6 that stood here was tuned on the synthetic fixture, where
# the label and value are drawn as ONE string and the offset is exactly zero.
# It excluded the name on the only genuinely filled form in the corpus, by two
# pixels, and reported the field as absent.
SAME_LINE_ABOVE = 0.6
SAME_LINE_BELOW = 0.9

# A mark shorter than this fraction of the label's height is a speck on the
# paper, not a character. The fixed-deposit scan carries a 3px artifact between
# the label and the name, and OCR calls it "." - so the depositor's name came
# back as "Ajit . Kumar Sahu". Real glyphs, including a comma, clear this.
MIN_GLYPH_HEIGHT = 0.25

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
# Indian mobiles are written as two or three groups, so a number spans at most
# a handful of tokens. Named rather than inlined, like the digit bounds above.
_MAX_PHONE_TOKENS = 4
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


# Words a printed label continues with, and a written value never starts with.
#
# The single biggest source of wrong reads, measured on filled forms. The anchor
# list carries short fallbacks ("Name", "Date") because plenty of forms print
# exactly that. On a form that prints something LONGER, the short entry still
# matches - "Name" against "Name of the Applicant (remitter)" - and the reader
# then hands back the REST OF THE LABEL as the value:
#
#     Name of the Applicant (remitter): Rajesh Venkataraman
#     ^^^^ anchor stopped here
#          ^^^^^^^^^^^^^^^^^^^^^^^^^^^ returned as the name
#
# Measured on the SMBC corpus this produced "of the Applicant remitter)", "of
# the Depositor(s)", "of Incorporation / Registration" and "of Birth" - four of
# the six wrong values, all the same bug. Nothing about them looks like a
# failure from the outside: the anchor score is high, OCR read the characters
# perfectly, and the field is confidently filled with furniture.
# How many words a label tail may run before we stop claiming to know where it
# ends. "Full name of the Depositor." is four; a run longer than this is not a
# label continuation any more, it is the rest of the form.
_MAX_LABEL_TAIL = 6

_LABEL_CONTINUES = frozenset(
    {"of", "the", "a", "an", "as", "in", "on", "to", "for", "and", "or", "at", "by", "with"}
)


def _same_line_right(page: Page, anchor: tuple[int, int, int, int]) -> list[Token]:
    """Tokens to the right of `anchor` on its line, left to right."""
    height = _height(anchor)
    centre = _centre_y(anchor)
    limit_x = anchor[2] + page.width * READ_RIGHT_SPAN
    candidates = [
        t
        for t in page.tokens
        if _height(t.bbox) >= height * MIN_GLYPH_HEIGHT
        and t.bbox[0] >= anchor[2]
        and t.bbox[0] <= limit_x
        and -height * SAME_LINE_ABOVE
        <= _centre_y(t.bbox) - centre
        <= height * SAME_LINE_BELOW
    ]
    candidates.sort(key=lambda t: t.bbox[0])
    return candidates


def _skip_label_tail(
    candidates: list[Token], anchor_right: int, height: int
) -> tuple[list[Token], int]:
    """Drop the rest of the printed label, when the anchor only matched its start.

    Fires only on positive evidence: the first token after the anchor is a
    lowercase connector word. People do not begin a name, a number or a date
    with "of" or "the", so this cannot eat a value - and when the anchor DID
    match the whole label, the next token is the value and nothing is skipped.

    Once triggered, the label runs to its natural end: a colon or asterisk, or
    the wide gap a form leaves before the answer space.
    """
    if not candidates:
        return candidates, anchor_right

    first = candidates[0].text.strip().strip(":*").lower()
    if first not in _LABEL_CONTINUES:
        return candidates, anchor_right

    previous_right = anchor_right
    for index, token in enumerate(candidates[:_MAX_LABEL_TAIL]):
        text = token.text.strip()
        # A gap this wide is the space left for the answer: the label ended.
        if token.bbox[0] - previous_right > height * VALUE_GAP_LIMIT:
            return candidates[index:], previous_right
        previous_right = token.bbox[2]
        # Punctuation ends a printed label outright.
        if text.endswith((":", "*", ".")):
            return candidates[index + 1 :], previous_right

    # The label ran on past anything that looks like an ending. Where it stops
    # is now a guess, and a guess here picks somebody's name out of printed
    # furniture - so this reads nothing and the reviewer types the field.
    return [], previous_right


def _read_right(page: Page, anchor: tuple[int, int, int, int]) -> list[Token]:
    """Tokens sitting to the right of `anchor` on the same line.

    Stops at the first wide gap. A form separates one field from the next with
    whitespace, so a gap is a boundary rather than a space - without this,
    "Full name: Priya Sharma    Mobile: 98765" reads as one very long name.
    """
    height = _height(anchor)
    candidates, previous_right = _skip_label_tail(
        _same_line_right(page, anchor), anchor[2], height
    )

    out: list[Token] = []
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


# What a value scores at most when it is not the shape the field asked for.
# Below PREFILL_MIN_CONFIDENCE in the app (0.7) on purpose: such a read is shown
# to the reviewer as something the scan offered, and never filled in for them.
SHAPE_MISMATCH_CEILING = 0.35

# Below this the characters were not read, they were guessed, and the honest
# answer is that the field was not read at all.
#
# Every other guard here asks whether a read is the RIGHT thing. This one asks
# whether it is a read at all, and it is the last line: when the comb detector
# missed, OCR handed back "Flee dsdrdstatetel fod" - mush off the cell walls -
# at 0.053, and nothing downstream rejected it. A real read of real characters
# does not score near here; the corpus's worst genuine field sits above 0.4.
#
# Deliberately not a ceiling like the one above. A shape mismatch is a legible
# value in the wrong format, which a reviewer can judge. This is noise, and
# showing noise beside a field teaches a reviewer to click past it.
MIN_LEGIBLE_CONFIDENCE = 0.2


def _plausible_for_kind(kind: str, value: str) -> bool:
    """Does the read look like the KIND of thing that was asked for?

    Deliberately loose - this is a sanity floor, not validation. E.164
    normalisation and date parsing happen in the app, which can refuse properly.
    """
    if kind == "phone":
        return _plausible_phone(value)
    if kind == "email":
        return "@" in value
    if kind == "date":
        # Any date carries digits; "of Incorporation / Registration" does not.
        return sum(c.isdigit() for c in value) >= 4
    if kind == "text":
        # A name is not a sentence, and not a single stray glyph.
        return 1 < len(value) <= 70 and any(c.isalpha() for c in value)
    return True


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
    if stripped.startswith("(") or stripped.startswith("["):
        return True
    # A closing bracket with no opener means we are INSIDE a parenthetical that
    # began in the printed label - OCR routinely loses the opening glyph, and
    # without this "Name of the Applicant (remitter)" returned "remitter)" as
    # somebody's name. Nobody writes their name with a trailing bracket.
    return stripped.endswith((")", "]")) and not any(c in stripped for c in "([")


# Kinds whose value has a shape you can check without knowing the answer.
# A name does not - "Rajesh Venkataraman" and "of the Depositor(s)" are both
# just words - so `text` is absent here on purpose.
_SHAPED_KINDS = frozenset({"phone", "email", "date"})


def _shaped(kind: str, tokens: list[Token]) -> list[Token] | None:
    """The part of the band that is actually the shape asked for.

    Reading the band left to right assumes the value starts where the label
    stops. Often it does not: the form prints "Date of Birth / Incorporation"
    or leaves a note between the label and the box, and the first thing beside
    the anchor is not the answer.

    So for a field with a checkable shape, FIND the answer in the band instead
    of assuming its position. If the band holds nothing of that shape, the
    honest result is None. It was previously returning the wrong text at capped
    confidence, which is a worse failure than an empty field: "date: e-mail
    address" on a review screen is noise a reviewer has to read and dismiss,
    and it hides the fact that nothing was found.
    """
    if kind == "email":
        for token in tokens:
            if _EMAIL.search(token.text):
                return [token]
        return None

    if kind == "phone":
        for start in range(len(tokens)):
            for span in range(1, _MAX_PHONE_TOKENS + 1):
                run = tokens[start : start + span]
                if len(run) < span:
                    break
                if _plausible_phone(" ".join(t.text for t in run)):
                    return run
        return None

    if kind == "date":
        # A date is digits and separators. Written as one token ("04/03/2019")
        # or three ("04", "03", "2019"), so allow a short run - but require the
        # run to be mostly digits, which "of Incorporation / Registration" and
        # "indiacsd@in.smbc.co.jp" are not.
        for start in range(len(tokens)):
            for span in range(1, 4):
                run = tokens[start : start + span]
                if len(run) < span:
                    break
                text = "".join(t.text for t in run)
                letters = sum(c.isalpha() for c in text)
                if len(_digits(text)) >= 4 and letters <= 3:
                    return run
        return None

    return tokens


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

# Section HEADERS are not field labels, and they collide with them by design.
# "Applicant Details" is a heading over a block of fields; "Applicant Name" is
# one of the fields under it. They share their first word, so a label list
# containing "Applicant Name" matches the HEADER strongly - and a header has
# nothing written beside it, so the read returns null while the real field sits
# unexamined two lines below.
#
# Measured on FILLED_Account_Opening_Savings_Form.pdf: the anchor landed on
# "Applicant Details" at 0.82 and the field returned None, with
# RAHUL TESTKUMAR SHARMA perfectly legible in the comb cells underneath. It is
# the same shape as the prose case below - a match that is not a label - so it
# belongs in the same guard.
#
# Penalised harder than the punctuation bonus can win back, because a header
# frequently scores BETTER than the field it heads: it is shorter, so the fuzzy
# ratio against a two-word label is higher.
SECTION_HEADER_PENALTY = 0.5
_SECTION_NOUNS = frozenset({"detail", "details", "information", "particulars"})


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
    # Both bounds. find_anchor tries windows of the label's word count plus or
    # minus two, and clamps its loop with max(1, ...), so on a page holding
    # fewer tokens than the widest window it calls this with an end_index past
    # the end. Guarding only the low side raised IndexError out of the middle of
    # extraction - a near-blank page, a cover sheet or an image-only scan took
    # the whole document down instead of reporting no fields.
    if 0 <= end_index - 1 < len(tokens):
        last = tokens[end_index - 1].text.strip()
        if last.endswith(":") or last.endswith("*:") or last.endswith("*"):
            return LABEL_PUNCTUATION_BONUS

    # A section header, not a field. Checked before the prose test because
    # "Details" carries no punctuation and would otherwise score as neutral.
    if end_index < len(tokens):
        following = normalise(tokens[end_index].text)
        if following in _SECTION_NOUNS:
            return -SECTION_HEADER_PENALTY

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


# How much a writable region beside a candidate is worth when choosing between
# two matches that score the same on text alone. Large, because on the forms
# where this matters the text scores are IDENTICAL (1.00 against "Name" both in
# the field label and in "affix rubber stamp of name and code no."), and the
# region is the only evidence that separates them.
REGION_EVIDENCE_BONUS = 0.30
# A candidate whose band is TEXT is prose or the next field. Penalised rather
# than dropped, so a form whose fields are all crowded still returns something
# for a human to correct rather than nothing.
REGION_TEXT_PENALTY = 0.35


def _band_right(
    page: Page, box: tuple[int, int, int, int], page_width: int
) -> tuple[int, int, int, int]:
    """The strip where a value written beside this label would sit.

    Measured from where the VALUE starts, not from where the anchor stopped,
    and the difference decides which field wins. On SMBC's fixed-deposit form
    the real field is "Full name of the Depositor". Anchoring on "Full name"
    left "of the Depositor" sitting in the band, the classifier called it text,
    and the correct field took the text penalty - so "CREDIT ACCOUNT NAME:" won
    on punctuation and the depositor's name read as null.

    A label's own continuation is not an obstacle in its answer space. Skipping
    it here is the same rule `_read_right` already applies, applied to the
    strip that CHOOSES the anchor rather than only to the one that reads it.
    """
    height = max(1, box[3] - box[1])
    _, start_x = _skip_label_tail(_same_line_right(page, box), box[2], height)
    return (
        start_x + 2,
        max(0, box[1] - int(height * 0.5)),
        min(page_width, box[2] + int(page_width * FIRST_GAP_LIMIT)),
        box[3] + int(height * 0.5),
    )


# Words that say the name beside them belongs to SOMEBODY ELSE.
#
# A consent record names the data principal. Anchoring on any of these puts a
# different person's name, number or address into it - which is the same harm
# as the page-wide scan that returned the applicant's Aadhaar as their phone,
# arriving by a different route. Found on SMBC's A2 form, where the extractor
# anchored on "Beneficiary's Name" and returned the printed cross-reference
# beside it at full anchor score.
#
# The vocabulary is the one `scripts/harvest_labels.py` already mines the
# corpus with, narrowed to OTHER PEOPLE: that file also excludes "branch" and
# "city", which are not the applicant but are not a person either, and have no
# business rejecting an anchor.
#
# "Remitter" is deliberately absent. SMBC prints "Name of the Applicant
# (remitter)", where the remitter IS the applicant.
_ANOTHER_PERSON = re.compile(
    r"\b(beneficiar(?:y|ies)|guarantor|co[\s\-]?applicant|nominee|witness|"
    r"father|mother|spouse|guardian|second\s+holder|third\s+holder|"
    r"joint\s+holder|authorised\s+signator)",
    re.I,
)

# How far left of an anchor to read when asking whose field this is, as a
# fraction of page width. A qualifier sits immediately before the label it
# qualifies; beyond this is the other column of a two-column form.
QUALIFIER_LOOKBEHIND = 0.25


def _names_another_person(page: Page, box: tuple[int, int, int, int]) -> bool:
    """Does the label this anchor sits in belong to someone other than the applicant?

    The qualifier can sit on either side of the matched words, so both are read:
    "Beneficiary's Name" puts it before, "Name of Guarantor" puts it after. The
    part after is exactly the label tail `_skip_label_tail` already identifies,
    so it is asked rather than re-derived.
    """
    height = _height(box)
    centre = _centre_y(box)
    left_limit = box[0] - page.width * QUALIFIER_LOOKBEHIND
    before = [
        t
        for t in page.tokens
        if t.bbox[2] <= box[2]
        and t.bbox[2] >= left_limit
        and abs(_centre_y(t.bbox) - centre) <= height * SAME_LINE_ABOVE
    ]
    before.sort(key=lambda t: t.bbox[0])

    # Whatever the label runs on into, before its answer space begins.
    right = _same_line_right(page, box)
    kept, _ = _skip_label_tail(right, box[2], height)
    tail = right[: len(right) - len(kept)]

    label = " ".join(t.text for t in before + tail)
    return bool(_ANOTHER_PERSON.search(label))


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
            if box is None or _names_another_person(page, box):
                continue
            width = box[2] - box[0]
            if (score, width) > (best_score, best_width):
                best_score, best_width, best_page, best_box = score, width, page, box

    return best_score, best_page, best_box


def _all_emails(pages: list[Page]) -> list[FieldResult]:
    """Every distinct address on the page.

    Deliberately not "the first address", which is what this used to return and
    which is wrong on essentially every real bank form. The applicant's address
    is not the first one printed - the bank's is. Measured on the corpus, a
    page-wide first-match handed back `depository@pnb.bank.in`,
    `suecontact@npci.org.in` and `sapcontact@npci.org.in` as the applicant's
    email, each with anchor_score 1.00, because a pattern match cannot tell
    whose address it found.

    This is the same bug already fixed for phone numbers, where the page-wide
    scan was returning the Aadhaar and then the Customer Number. The remedy is
    the same: the printed label leads, and a page-wide scan may only answer
    when the page holds exactly one candidate and there is nothing to confuse.
    """
    found: list[FieldResult] = []
    seen: set[str] = set()

    def add(value: str, tokens: list[Token], page: Page) -> None:
        value = value.lower()
        if value in seen:
            return
        seen.add(value)
        box = _span_box(tokens)
        found.append(
            FieldResult(
                key="",
                value=value,
                confidence=_mean_confidence(tokens),
                anchor_score=1.0,
                method="pattern",
                page=page.page,
                bbox=box,
            )
        )

    for page in pages:
        for index, token in enumerate(page.tokens):
            match = _EMAIL.search(token.text)
            if match:
                add(match.group(0), [token], page)
                continue
            # OCR sometimes splits on the @, so try joining with the neighbour -
            # but ONLY when neither token is already a whole address.
            #
            # Without that guard the join manufactures candidates: the token
            # before the address is "43210", and "43210priya.sharma@example.org"
            # matches the pattern as a different string. One address on the page
            # then counts as two, and the "exactly one candidate" rule below -
            # the entire safety mechanism - never fires.
            if index + 1 >= len(page.tokens):
                continue
            neighbour = page.tokens[index + 1]
            if _EMAIL.search(neighbour.text):
                continue
            # A split happens within a line, not across one.
            if abs(_centre_y(neighbour.bbox) - _centre_y(token.bbox)) > _height(token.bbox):
                continue
            match = _EMAIL.search(token.text + neighbour.text)
            if match:
                add(match.group(0), [token, neighbour], page)
    return found


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


def _best_anchor_with_regions(
    pages: list[Page],
    labels: list[str],
    images: dict[int, "Image.Image"],
) -> tuple[float, Page | None, tuple[int, int, int, int] | None]:
    """Pick the anchor that has somewhere to write beside it.

    Text score alone cannot separate a field label from the same words in a
    sentence. This re-ranks the candidates by what follows them on the page: a
    comb, a table cell or a ruled blank is evidence of a field; running text is
    evidence of prose.
    """
    best = (0.0, None, None)
    best_rank = -1.0

    for page in pages:
        image = images.get(page.page)
        for label in labels:
            for score, box, _end in find_anchors(page.tokens, label, bonus=_label_bonus):
                if score < MIN_ANCHOR_SCORE or _names_another_person(page, box):
                    continue
                rank = score
                if image is not None:
                    region = regions.classify(image, _band_right(page, box, page.width), page.tokens)
                    if region.is_field:
                        rank += REGION_EVIDENCE_BONUS
                    elif region.kind == "text":
                        rank -= REGION_TEXT_PENALTY
                if rank > best_rank:
                    best_rank, best = rank, (score, page, box)

    return best


def _all_phones(pages: list[Page]) -> list[FieldResult]:
    """Every number-shaped run on the page, not merely the first.

    Counting them is the point: one is an answer, several is a question nobody
    asked this function to settle.
    """
    out: list[FieldResult] = []
    for page in pages:
        tokens = page.tokens
        index = 0
        while index < len(tokens):
            run: list[Token] = []
            digits = ""
            for token in tokens[index : index + _MAX_PHONE_TOKENS]:
                if any(c.isalpha() for c in token.text):
                    break
                run.append(token)
                digits += _digits(token.text)
                if len(digits) > _MAX_PHONE_DIGITS:
                    break
                if _MIN_PHONE_DIGITS <= len(digits) <= _MAX_PHONE_DIGITS:
                    out.append(
                        FieldResult(
                            key="",
                            value=" ".join(_clean(t.text) for t in run).strip(),
                            confidence=_mean_confidence(run),
                            anchor_score=1.0,
                            method="pattern",
                            page=page.page,
                            bbox=_span_box(run),
                        )
                    )
                    index += len(run)
                    break
            else:
                index += 1
                continue
            index += 1
    return out


def _read_anchored(
    pages: list[Page],
    request: FieldRequest,
    images: dict[int, "Image"] | None = None,
) -> FieldResult:
    """Locate the printed label, read the value beside it."""
    score, page, box = (
        _best_anchor_with_regions(pages, list(request.labels), images)
        if images
        else _best_anchor(pages, request.labels)
    )

    if page is None or box is None or score < MIN_ANCHOR_SCORE:
        return FieldResult(
            key=request.key, value=None, confidence=0.0, anchor_score=score, method=None
        )

    tokens = _read_right(page, box)

    # A comb band's words are the form's own guide letters, not an answer.
    #
    # SBI's account-opening form prints F I R S T  N A M E faintly inside the
    # character cells, and OCR reads them perfectly well - so the name field
    # came back as "MIDDLE NAME" with a strong anchor and clean characters.
    # Nothing about that read looks wrong from the outside, and it would be
    # pre-filled into a consent record as somebody's name.
    #
    # Reading the cells properly means OCR'ing each one as a single character,
    # which the engine seam does not expose (it takes a page, returns words) and
    # which local Tesseract is unlikely to manage regardless - it turned a
    # handwritten "ajitbubu" into "i1tbubu" at full word size. So the value here
    # is None: the field is visibly empty on the review screen and gets typed,
    # instead of being confidently wrong. Comb READING stays open, and is the
    # strongest argument in the corpus for the cloud engine.
    if images is not None and tokens:
        image = images.get(page.page)
        if image is not None:
            # Read to the page edge, NOT to _band_right's limit. That limit is
            # FIRST_GAP_LIMIT, which answers "how far right might this label's
            # value start" - a question about the label. Whether cells are
            # printed is a question about the paper, and the two must not share
            # an edge.
            #
            # Sharing it put the guard one pixel from silent failure. The band's
            # right edge is the label box plus a fraction of the page, so it
            # moves whenever OCR reports the label a few pixels narrower, and it
            # was landing with EXACTLY the five dividers _looks_like_comb needs.
            # Measured on the SBI comb fixture: right edge 700 found five walls
            # and nulled the field, 699 found four and handed back
            # "Flee dsdrdstatetel fod" as somebody's name. It passed locally and
            # failed on the CI runner for no reason but a different Tesseract
            # build. Reading to the page edge sees all thirteen walls.
            band = _band_right(page, box, page.width)
            structure = (band[0], band[1], page.width, band[3])
            if regions.classify(image, structure, page.tokens).kind == "comb":
                tokens = []

    if request.kind in _SHAPED_KINDS:
        shaped = _shaped(request.kind, tokens)
        tokens = shaped if shaped is not None else []
    value = _clean(" ".join(t.text for t in tokens))

    # An address is the MATCH, not the token that carried it. OCR glues the
    # rule a value sits on to the front of the word, and returning the token
    # whole handed back "tD[rajepsh.v@example.org" - a string the app's own
    # normalisation would then reject for a reason invisible from the scan.
    if request.kind == "email" and value:
        match = _EMAIL.search(value)
        value = match.group(0).lower() if match else ""

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

    # The value is only as trustworthy as the WEAKEST of three things: how sure
    # we are of the label, how sure OCR is of the characters, and whether what
    # was read is the SHAPE the field asked for.
    #
    # The third was missing and it mattered. Confidence was measuring "did I
    # read these characters correctly", which a clean read of the wrong text
    # passes easily: on a real account-opening form the date field returned "of
    # Incorporation / Registration" at 0.94 and the phone field returned "No" at
    # 0.96 - both high enough to pre-fill a compliance record. A number that is
    # not a number and a date that is not a date are not near misses.
    confidence = min(score, _mean_confidence(tokens))
    if not _plausible_for_kind(request.kind, value):
        confidence = min(confidence, SHAPE_MISMATCH_CEILING)

    if confidence < MIN_LEGIBLE_CONFIDENCE:
        # Illegible. Reported the same way a blank field is, because that is
        # what the reviewer is looking at: nothing they can use.
        return FieldResult(
            key=request.key,
            value=None,
            confidence=0.0,
            anchor_score=score,
            method="anchored",
            page=page.page,
            bbox=box,
        )

    return FieldResult(
        key=request.key,
        value=value,
        confidence=confidence,
        anchor_score=score,
        method="anchored",
        page=page.page,
        bbox=_span_box(tokens),
    )


def read(
    pages: list[Page],
    requests: list[FieldRequest],
    images: dict[int, "Image"] | None = None,
) -> list[FieldResult]:
    """One result per request, in the order asked for.

    A request always produces a result, even a failed one. Silence would be
    indistinguishable from the app forgetting to ask.
    """
    results: list[FieldResult] = []

    for request in requests:
        if request.kind == "email":
            # The printed label leads, exactly as it does for a phone number.
            #
            # An address IS self-identifying - an @ is an @ wherever it sits -
            # and that is precisely why a page-wide scan is dangerous here: it
            # finds the bank's address as confidently as the applicant's, and
            # the bank's is printed first. See _all_emails.
            anchored = _read_anchored(pages, request, images)
            if anchored.value and "@" in anchored.value:
                results.append(anchored)
                continue

            candidates = _all_emails(pages)
            if len(candidates) == 1:
                results.append(candidates[0].model_copy(update={"key": request.key}))
                continue
            results.append(anchored)
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
            anchored = _read_anchored(pages, request, images)
            if anchored.value and _plausible_phone(anchored.value):
                results.append(anchored)
                continue

            # The page-wide scan is the fallback, and it is now allowed to
            # answer ONLY when the page holds exactly one number-shaped run.
            #
            # It was returning the first 10-13 digit run it found, and on a real
            # filled account-opening form that was the Customer Number
            # (686868686868) - reported as the applicant's phone with full
            # confidence. The same shape as the Aadhaar case: a page-wide scan
            # cannot know which number is the one asked for, and on a form
            # carrying several it will be wrong more often than right.
            #
            # Ambiguity now returns nothing. A missed field is visibly empty on
            # the review screen and gets typed; a wrong one is a contact point
            # that looks filled in and never reaches the person.
            candidates = _all_phones(pages)
            if len(candidates) == 1:
                results.append(candidates[0].model_copy(update={"key": request.key}))
                continue
            results.append(anchored)
            continue

        results.append(_read_anchored(pages, request, images))

    return results


__all__ = ["read", "MIN_ANCHOR_SCORE"]
