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

from .conftest import build_form

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


def test_finds_the_email_by_pattern_not_by_label(clean_pages):
    result = _by_key(fields.read(clean_pages, [EMAIL]), "email")
    # Asserting the SHAPE, not the exact characters: tesseract sometimes doubles
    # a letter on a rendered form, and OCR fidelity is a different test from
    # "was an address found without relying on the word Email".
    assert result.value is not None
    assert result.value.endswith("@example.org")
    assert result.value.startswith("priya")
    # An address is self-identifying, so it should be found without relying on
    # the word "Email" having survived OCR.
    assert result.method == "pattern"
    assert result.anchor_score == 1.0


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
