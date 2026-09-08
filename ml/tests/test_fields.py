"""
Reading the handwritten fields off a synthetic form.

The point these tests defend is that name, phone and email come off a labelled
consent form with NO trained model and NO corpus - the printed label is the
anchor, exactly as it is for tick-boxes. If that stops being true, the app loses
its only field extraction until the layout model exists.
"""

from __future__ import annotations

import pytest
from PIL import Image

from app import fields
from app.contract import FieldRequest, Page
from app.engines import get_engine

from PIL import ImageDraw

from .conftest import _font, build_form

NAME = FieldRequest(key="fullName", labels=["Full name", "Name"], kind="text")
PHONE = FieldRequest(key="phone", labels=["Mobile", "Phone", "Mobile No"], kind="phone")
EMAIL = FieldRequest(key="email", labels=["Email", "Email address"], kind="email")
DATE = FieldRequest(key="collectedOn", labels=["Signed", "Date"], kind="date")


def _pages(image: Image.Image) -> list[Page]:
    engine = get_engine()
    return [Page(page=1, width=image.width, height=image.height, tokens=engine.tokens(image))]


@pytest.fixture(scope="module")
def clean_pages() -> list[Page]:
    return _pages(build_form({0}))


def _by_key(results, key):
    return next(r for r in results if r.key == key)


def test_reads_the_name_from_beside_its_printed_label(clean_pages):
    result = _by_key(fields.read(clean_pages, [NAME]), "fullName")
    assert result.value is not None
    assert "priya" in result.value.lower()
    assert "sharma" in result.value.lower()
    # Anchored, not guessed: the label is what made this readable.
    assert result.method == "anchored"
    assert result.anchor_score >= fields.MIN_ANCHOR_SCORE


def test_the_name_does_not_swallow_the_next_field(clean_pages):
    # "Full name: Priya Sharma" and "Mobile: 98765 43210" are different lines,
    # but a form with two columns puts them side by side - and a value that runs
    # on would put a phone number into somebody's name.
    result = _by_key(fields.read(clean_pages, [NAME]), "fullName")
    assert "98765" not in (result.value or "")
    assert "mobile" not in (result.value or "").lower()


def test_reads_the_email_from_beside_its_printed_label(clean_pages):
    result = _by_key(fields.read(clean_pages, [EMAIL]), "email")
    # Asserting the SHAPE, not the exact characters: tesseract sometimes doubles
    # a letter on a rendered form, and OCR fidelity is a different test from
    # "was the right address found".
    assert result.value is not None
    assert result.value.endswith("@example.org")
    assert result.value.startswith("priya")


def test_finds_the_only_address_on_a_form_that_never_says_email():
    """The pattern fallback still works when the label is gone.

    This is what makes an address different from a name: with no usable label,
    a page carrying exactly ONE address can still be answered. The guard is
    "exactly one" - see the next test for why.
    """
    image = build_form({0})
    draw = ImageDraw.Draw(image)
    # Paint over the printed "Email:" label, leaving the address alone.
    draw.rectangle([135, 365, 300, 410], fill=255)
    result = _by_key(fields.read(_pages(image), [EMAIL]), "email")
    assert result.value is not None
    assert result.value.endswith("@example.org")
    assert result.method == "pattern"


def test_does_not_return_the_banks_own_address_as_the_applicants():
    """The bug this replaced a page-wide first-match to fix.

    Every real bank form prints the bank's own address somewhere, usually
    above the applicant's. Taking the first `@` on the page returned
    `depository@pnb.bank.in` and `suecontact@npci.org.in` as the applicant's
    email on the training corpus, at anchor_score 1.00 - a contact point that
    looks filled in, is wrong, and never reaches the person.
    """
    image = build_form({0})
    draw = ImageDraw.Draw(image)
    # A footer address, exactly as a bank prints it - and ABOVE nothing, so a
    # first-match scan that started at the top would still find the applicant.
    # Put it in the header instead, where the scan reaches it first.
    draw.text((900, 130), "queries@bank.example.com", font=_font(32), fill=0)

    result = _by_key(fields.read(_pages(image), [EMAIL]), "email")
    assert result.value is not None
    assert "bank.example.com" not in result.value
    assert result.value.startswith("priya")


def test_finds_the_phone_across_split_tokens(clean_pages):
    # OCR splits "98765 43210" into two tokens; ten digits only exist across
    # both, so a per-token match would miss every Indian mobile on paper.
    result = _by_key(fields.read(clean_pages, [PHONE]), "phone")
    assert result.value is not None
    digits = "".join(c for c in result.value if c.isdigit())
    assert digits == "9876543210"


def test_reads_the_date_beside_its_label(clean_pages):
    result = _by_key(fields.read(clean_pages, [DATE]), "collectedOn")
    assert result.value is not None
    assert "2019" in result.value


def test_a_field_with_no_label_on_the_form_reads_null_not_a_guess():
    # The single most important property here. A form that never mentions a
    # passport number must not return whatever text happened to be nearby: a
    # confidently wrong pre-fill is worse than an empty field, because
    # reviewers stop checking things that are usually right.
    pages = _pages(build_form(set()))
    missing = FieldRequest(key="passport", labels=["Passport number"], kind="text")
    result = _by_key(fields.read(pages, [missing]), "passport")
    assert result.value is None
    assert result.method is None
    assert result.anchor_score < fields.MIN_ANCHOR_SCORE


def test_every_request_gets_a_result_even_when_it_fails(clean_pages):
    missing = FieldRequest(key="nino", labels=["National insurance"], kind="text")
    results = fields.read(clean_pages, [NAME, missing, EMAIL])
    # Silence would be indistinguishable from the app forgetting to ask.
    assert [r.key for r in results] == ["fullName", "nino", "email"]


def test_survives_a_dirty_scan():
    # The paper is no longer 255. Anchoring reads text, so it should not care -
    # this is the property that lets the same code work on a real scanner.
    pages = _pages(build_form({0, 2}, noise=True))
    results = fields.read(pages, [NAME, EMAIL, PHONE])
    assert (_by_key(results, "email").value or "").endswith("@example.org")
    assert "priya" in (_by_key(results, "fullName").value or "").lower()


def _columnar_form() -> Image.Image:
    """A form laid out in columns, which is how real ones are printed."""
    from pathlib import Path
    from PIL import ImageDraw, ImageFont

    for path in [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            font = ImageFont.truetype(path, 34)
            break
    else:
        pytest.skip("no scalable font available")

    image = Image.new("L", (1700, 900), 255)
    draw = ImageDraw.Draw(image)
    # The label column and the value column are far apart. That distance is the
    # whole point of this fixture.
    for row, (label, value) in enumerate(
        [("Full name:", "Priya Sharma"), ("Mobile:", "98765 43210"), ("Signed:", "4 March 2019")]
    ):
        y = 120 + row * 90
        draw.text((140, y), label, font=font, fill=0)
        draw.text((620, y), value, font=font, fill=0)
    return image


def test_reads_a_value_across_a_wide_label_gap():
    # REGRESSION. Forms are laid out in columns: "Full name:" at x=140 and the
    # value at x=620. Measuring that gap with the same tolerance used between
    # words made the reader stop before the value, and every name on a real
    # form came back null at 0.00 confidence. The fixture form hid it by
    # drawing label and value as a single string.
    pages = _pages(_columnar_form())
    results = fields.read(pages, [NAME, DATE])
    name = _by_key(results, "fullName")
    assert name.value is not None, "wide label-to-value gap must not end the read"
    assert "priya" in name.value.lower()
    assert "2019" in (_by_key(results, "collectedOn").value or "")


def test_a_wide_gap_still_does_not_run_into_the_next_label():
    # The other half of the same fix: a generous FIRST gap must not let a value
    # swallow the next column of a two-column form. Labels are punctuated;
    # names are not, and that is the signal used to stop.
    pages = _pages(_columnar_form())
    name = _by_key(fields.read(pages, [NAME]), "fullName")
    assert "mobile" not in (name.value or "").lower()
    assert "98765" not in (name.value or "")


def test_printed_instructions_do_not_become_a_value():
    # REGRESSION, found against real bank forms. Beside "Mobile No." the SBI
    # account-opening form prints "(Mandatory for CKYC update request)", and the
    # reader returned that as the phone number with anchor 1.00 - the label was
    # found, so nothing looked wrong. Parentheses are printed guidance; nobody
    # writes their own details in brackets.
    from pathlib import Path
    from PIL import ImageDraw, ImageFont

    for path in [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            font = ImageFont.truetype(path, 34)
            break
    else:
        pytest.skip("no scalable font available")

    image = Image.new("L", (1700, 400), 255)
    draw = ImageDraw.Draw(image)
    draw.text((140, 120), "Mobile No:", font=font, fill=0)
    draw.text((620, 120), "(Mandatory for CKYC update)", font=font, fill=0)

    result = _by_key(fields.read(_pages(image), [PHONE]), "phone")
    assert result.value is None or "mandatory" not in result.value.lower()


def test_a_twelve_digit_id_is_not_returned_as_the_phone():
    """REGRESSION. An Aadhaar number is TWELVE digits.

    `_find_phone` scans the whole page for the first 10-13 digit run, so on an
    Indian form carrying both an Aadhaar field and a mobile field it handed back
    the Aadhaar as the applicant's phone, at anchor 1.0 - wrong field, and the
    most sensitive identifier on the paper, stored as a contact point. The fix
    is that the printed label leads and the page-wide scan is only a fallback.
    """
    from pathlib import Path
    from PIL import ImageDraw, ImageFont

    for path in [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            font = ImageFont.truetype(path, 34)
            break
    else:
        pytest.skip("no scalable font available")

    image = Image.new("L", (1700, 500), 255)
    draw = ImageDraw.Draw(image)
    # The Aadhaar sits ABOVE the mobile, so a page-order scan reaches it first.
    draw.text((140, 100), "Aadhaar No:", font=font, fill=0)
    draw.text((620, 100), "9876 5432 1098", font=font, fill=0)
    draw.text((140, 200), "Mobile No:", font=font, fill=0)
    draw.text((620, 200), "98765 43210", font=font, fill=0)

    result = _by_key(fields.read(_pages(image), [PHONE]), "phone")
    digits = "".join(c for c in (result.value or "") if c.isdigit())
    assert digits != "987654321098", "the Aadhaar number must never be read as the phone"
    assert digits == "9876543210"


def test_confidence_never_exceeds_the_anchor(clean_pages):
    # A value is only as trustworthy as our certainty that we found the right
    # label. Reporting more confidence than that would invite an auto-fill the
    # evidence cannot support.
    result = _by_key(fields.read(clean_pages, [NAME]), "fullName")
    assert result.confidence <= result.anchor_score


def test_a_comb_field_reads_null_rather_than_the_forms_guide_letters():
    """REGRESSION. The printed guide inside character cells is not a name.

    SBI's account-opening form prints F I R S T  N A M E faintly inside the
    comb cells that a person writes their name into. OCR reads those guide
    letters cleanly, so the name field came back as "MIDDLE NAME" with a strong
    anchor score and high character confidence - a confident wrong answer, and
    the kind that gets pre-filled into a consent record because nothing about
    it looks like a failure.

    Reading the cells themselves is still open work. Until it lands, an empty
    field a reviewer types into beats a plausible name nobody wrote.
    """
    image = Image.new("L", (1400, 200), 255)
    draw = ImageDraw.Draw(image)
    draw.text((60, 80), "Full name", font=_font(36), fill=0)

    # 12 character cells, with the form's guide letters printed inside them.
    left, cell, top, bottom = 460, 60, 70, 130
    for i in range(13):
        draw.line([left + i * cell, top, left + i * cell, bottom], fill=0, width=3)
    for i, character in enumerate("FIRSTNAME"):
        draw.text((left + i * cell + 20, top + 14), character, font=_font(28), fill=0)

    pages = _pages(image)
    result = _by_key(fields.read(pages, [NAME], {1: image}), "fullName")

    assert result.anchor_score >= fields.MIN_ANCHOR_SCORE  # the label WAS found
    assert result.value is None


def test_reads_a_value_written_below_the_printed_labels_baseline():
    """REGRESSION. A written value does not sit level with its label.

    The label's box is the tight bounds of printed x-height; a written value
    carries ascenders and descenders, so its box is taller and its centre falls
    BELOW the label's. On SMBC's fixed-deposit form the depositor's name sits
    19px under a 23px label, and a symmetric same-line tolerance of 0.6 excluded
    it by two pixels - reporting the field as absent on the one genuinely filled
    form in the corpus.

    The synthetic fixture could never have caught this: it draws the label and
    the value as a single string, so the offset is exactly zero.
    """
    image = Image.new("L", (1400, 260), 255)
    draw = ImageDraw.Draw(image)
    draw.text((60, 60), "Full name", font=_font(34), fill=0)
    # Written lower, as a person writing on the line below the caption does.
    draw.text((460, 78), "Ajit Kumar Sahu", font=_font(38), fill=0)
    # The next printed line, which must NOT be pulled in.
    draw.text((60, 150), "Mobile:", font=_font(34), fill=0)

    result = _by_key(fields.read(_pages(image), [NAME]), "fullName")

    assert result.value is not None
    assert "kumar" in result.value.lower()
    assert "mobile" not in result.value.lower()


def test_never_returns_another_persons_name_as_the_applicants():
    """A consent record names the data principal, not the guarantor.

    Found on SMBC's A2 form, where extraction anchored on "Beneficiary's Name"
    at full score. Putting the beneficiary's name into a consent artifact is
    the same harm as the page-wide scan that returned the applicant's Aadhaar
    as their phone number - the right shape, the wrong person - and it is worse
    than reading nothing, because nothing is visibly empty on the review screen.
    """
    image = Image.new("L", (1400, 320), 255)
    draw = ImageDraw.Draw(image)
    draw.text((60, 60), "Beneficiary's Name:", font=_font(34), fill=0)
    draw.text((520, 60), "Rakesh Gupta", font=_font(34), fill=0)
    draw.text((60, 180), "Full name:", font=_font(34), fill=0)
    draw.text((520, 180), "Priya Sharma", font=_font(34), fill=0)

    result = _by_key(fields.read(_pages(image), [NAME]), "fullName")

    assert result.value is not None
    assert "priya" in result.value.lower()
    assert "rakesh" not in result.value.lower()


def test_a_form_that_only_names_a_guarantor_reads_null():
    """With no applicant label on the paper, the answer is nothing at all."""
    image = Image.new("L", (1400, 200), 255)
    draw = ImageDraw.Draw(image)
    draw.text((60, 60), "Name of Guarantor:", font=_font(34), fill=0)
    draw.text((520, 60), "Rakesh Gupta", font=_font(34), fill=0)

    result = _by_key(fields.read(_pages(image), [NAME]), "fullName")
    assert result.value is None


def test_a_bracketed_qualifier_is_not_a_value_even_with_the_opener_lost():
    """OCR drops the opening paren, so the closer is the only evidence left.

    SMBC prints "Name of the Applicant (remitter)". Tesseract read the tail as
    the bare token "remitter)", which starts with no bracket - so the guard that
    catches printed instructions missed it and "remitter)" came back as a name.
    """
    assert fields._looks_like_instruction("(remitter)")
    assert fields._looks_like_instruction("remitter)")
    assert not fields._looks_like_instruction("Sharma")
