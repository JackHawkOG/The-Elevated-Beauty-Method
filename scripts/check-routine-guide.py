"""Check the current review PDF and render changed pages for visual inspection."""
from pathlib import Path
import hashlib
import re
import pymupdf as fitz

EXPECTED_SHA = "3341f8f6b4003d58d5f88b0681f7b41594beb0e1d4ff4114637c1cac39c76f29"
for source in [
    "attached_assets/Elevated-Routine-Guide_1790514157477.pdf",
    "attached_assets/Elevated-Routine-Guide_1790515184742.pdf",
]:
    assert hashlib.sha256(Path(source).read_bytes()).hexdigest() == EXPECTED_SHA, source

doc = fitz.open("docs/assets/the-elevated-routine-review.pdf")
assert len(doc) == 9
assert doc.metadata["title"] == "The Elevated Routine — review copy"
def normalize(text):
    text = text.replace("\u2010", "-").replace("\u2219", "·")
    text = re.sub(r"\s*[·]\s*", " · ", text)
    return re.sub(r"\s+", " ", text).strip()


texts = [normalize(page.get_text()) for page in doc]
assert all("\x00" not in text and "\ufffd" not in text for text in texts), "Missing font glyphs"
assert "The Elevated Routine" in texts[0]
assert "The Elevated Routine answers" in texts[1]
assert texts[1].count("clarity, more confidence, and more ease.") == 1
assert "HOW TO USE THE ELEVATED ROUTINE" in texts[1]
assert "Everything in The Elevated Routine" in texts[8]
assert "The Elevated Routine Guide" not in " ".join(texts)
assert not re.search(r"\bMARI\b(?! V1)", " ".join(texts))
assert "Priority access to MARI V1" in texts[8]
# Compare the screenshot wording with only the owner's requested substitutions.
q3_original = (
    "COMING SOON · MARI · Finding a complexion match in natural light is exactly what MARI, "
    "our AI shade-matching tool, is being built to do. From a single photo, it will read your "
    "skin's undertones and match you to your ideal foundation and concealer shades. "
    "Founding Members get it first."
)
q7_original = (
    "COMING SOON · MARI · If you suspect your shade is the problem, MARI will soon take the "
    "guesswork out of it: one photo, and a match built from your own skin. "
    "Founding Members get it first."
)
expected_q3 = q3_original.replace("MARI", "MARI V1").replace(
    "what MARI V1, our AI", "what MARI V1, our first production release of our AI"
)
assert expected_q3 in texts[3], "Q3 differs from the requested screenshot edits"
assert q7_original.replace("MARI", "MARI V1") in texts[5], "Q7 screenshot wording changed"
assert "What should I do if my routine still isn't working?" in texts[5]
source = fitz.open("attached_assets/Elevated-Routine-Guide_1790514157477.pdf")
for index, rect in [(3, (64.7, 108, 547, 216)), (5, (64.7, 144, 547, 193))]:
    assert normalize(source[index].get_text(clip=fitz.Rect(rect))) in texts[index]
for index, sentence in [
    (3, "Let your features lead. That is where timeless elegance lives."),
    (5, "When you troubleshoot with honesty, you make room for a routine that finally feels like yours."),
]:
    assert sentence in texts[index]

for index, count in [(3, 2), (5, 2), (8, 1)]:
    assert texts[index].count("MARI V1") == count
    if index == 3:
        assert "what MARI V1, our first production release of our AI" in texts[index]
    spans = [
        span
        for block in doc[index].get_text("dict")["blocks"]
        for line in block.get("lines", [])
        for span in line["spans"]
        if "MARI V1" in re.sub(r"\s+", " ", span["text"])
    ]
    assert len(spans) == count
    assert all(span["color"] == 0xC87A96 for span in spans)

pink_lines = [
    drawing for drawing in doc[8].get_drawings()
    if drawing["color"] is not None
    and all(abs(a - b) < 0.001 for a, b in zip(drawing["color"], (200 / 255, 122 / 255, 150 / 255)))
    and drawing["rect"].x0 < 93.6
    and 420 <= drawing["rect"].y0 < drawing["rect"].y1 <= 445
]
assert pink_lines, "Missing pink line beside the last membership bullet"
assert {link["uri"] for link in doc[8].get_links()} == {
    "https://elevatedbeautymethod.com/membership",
    "https://elevatedbeautymethod.com/radiant-audit",
}
button = fitz.Rect(87.4, 676, 338.867, 711.12)
label_spans = [
    span
    for block in doc[8].get_text("dict", clip=button)["blocks"]
    for line in block.get("lines", [])
    for span in line["spans"]
]
assert "TAKETHERADIANTAUDIT" == re.sub(r"\s+", "", doc[8].get_text(clip=button))
assert label_spans and all(span["color"] == 0x0A0A0A for span in label_spans)
button_shapes = [drawing for drawing in doc[8].get_drawings()
                 if all(abs(a - b) < 0.01 for a, b in zip(drawing["rect"], button))]
assert any(drawing["fill"] and
           all(abs(a - b) < 0.001 for a, b in zip(drawing["fill"], (1, 235 / 255, 191 / 255)))
           for drawing in button_shapes), "Audit button does not match the Founding button fill"
audit_links = [link for link in doc[8].get_links()
               if link["uri"] == "https://elevatedbeautymethod.com/radiant-audit"]
assert len(audit_links) == 1
assert all(abs(a - b) < 0.01 for a, b in zip(audit_links[0]["from"], button))
assert "$24/month" in texts[8] and "$48/month" in texts[8]
assert "Oct 1–7, 2026" in texts[8]
assert "subject to checkout availability" in texts[8]
assert "Dominique" in texts[0]

output = Path(".agents/outputs/the-elevated-routine")
output.mkdir(parents=True, exist_ok=True)
for index in [0, 1, 3, 5, 8]:
    doc[index].get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(output / f"page-{index + 1}.png")
    print(f"PAGE {index + 1}: {texts[index]}")
print("PASS: originals preserved, screenshot wording, title, MARI V1 pink styling, filled Audit button, and CTA links")