"""Produce a review copy without modifying or publishing the uploaded source."""
from pathlib import Path
import hashlib
import re
import pymupdf as fitz

SOURCE = Path("attached_assets/Elevated-Routine-Guide_1790514157477.pdf")
DEST = Path("docs/assets/the-elevated-routine-review.pdf")
EXPECTED_SHA = "3341f8f6b4003d58d5f88b0681f7b41594beb0e1d4ff4114637c1cac39c76f29"
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == EXPECTED_SHA
doc = fitz.open(SOURCE)
fonts = {name.split("+")[-1]: doc.extract_font(xref)[3]
         for xref, _, _, name, *_ in doc[0].get_fonts()}
for name, file in [("Lato", "Regular"), ("Lato-Bold", "Bold"), ("Lato-Light", "Light")]:
    fonts[name] = Path(f"scripts/assets/routine-guide-fonts/Lato-{file}.ttf").read_bytes()
fonts["Cormorant"] = Path("scripts/assets/routine-guide-fonts/Cormorant-Regular.ttf").read_bytes()
fonts["Cormorant-Medium"] = Path("scripts/assets/routine-guide-fonts/Cormorant-Medium.ttf").read_bytes()
CREAM = (245 / 255, 238 / 255, 224 / 255)
BLACK = (10 / 255,) * 3
PANEL = (18 / 255,) * 3
CALLOUT = (28 / 255,) * 3
PINK = (200 / 255, 122 / 255, 150 / 255)
GOLD = (1, 235 / 255, 191 / 255)
AUDIT_BUTTON = fitz.Rect(87.4, 676, 338.867, 711.12)


def replace(page, rect, text, size=10, background=BLACK, font="Lato", height=None, right=None,
            color=CREAM, lineheight=1.5):
    rect = fitz.Rect(rect)
    page.add_redact_annot(rect, fill=background)
    page.apply_redactions(images=0, graphics=0)
    alias = "Revision" + font.replace("-", "")
    page.insert_font(fontname=alias, fontbuffer=fonts[font])
    area = fitz.Rect(rect)
    if right:
        area.x1 = right
    if height:
        area.y1 = area.y0 + height
    remaining = page.insert_textbox(area, text, fontname=alias, fontsize=size,
                                   color=color, lineheight=lineheight)
    if remaining < 0:
        raise ValueError(f"Text overflow on page {page.number + 1}: {text}")


def replace_mari(page, rect, text, size=10, background=CALLOUT, height=None,
                 body_font="Lato"):
    """Wrap complete words while keeping every MARI V1 mention together and pink."""
    rect = fitz.Rect(rect)
    area = fitz.Rect(rect)
    if height:
        area.y1 = area.y0 + height
    tokens = re.findall(r"MARI V1[,.]?|Founding Members get it first\.|[^\s]+", text)
    metrics = {name: fitz.Font(fontbuffer=fonts[name]) for name in (body_font, "Lato-Bold")}
    lines = [[]]
    width = 0
    space = metrics[body_font].text_length(" ", fontsize=size)
    for index, token in enumerate(tokens):
        is_label = text.startswith("COMING SOON ·") and index < 3
        font = "Lato-Bold" if token.startswith("MARI V1") or is_label else body_font
        color = PINK if token.startswith("MARI V1") else GOLD if is_label else CREAM
        length = metrics[font].text_length(token, fontsize=size)
        if length > area.width:
            raise ValueError(f"Unwrappable word on page {page.number + 1}: {token}")
        gap = space if lines[-1] else 0
        if width + gap + length > area.width:
            lines.append([])
            width, gap = 0, 0
        lines[-1].append((token, font, length, gap, color))
        width += gap + length
    ascent = max(font.ascender for font in metrics.values()) * size
    descent = max(-font.descender for font in metrics.values()) * size
    if ascent + descent + (len(lines) - 1) * size * 1.5 > area.height:
        raise ValueError(f"Text overflow on page {page.number + 1}: {text}")
    page.add_redact_annot(rect, fill=background)
    page.apply_redactions(images=0, graphics=0)
    for font in metrics:
        page.insert_font(fontname="Revision" + font.replace("-", ""), fontbuffer=fonts[font])
    for index, line in enumerate(lines):
        x = area.x0
        y = area.y0 + ascent + index * size * 1.5
        for token, font, length, gap, color in line:
            x += gap
            page.insert_text((x, y), token,
                             fontname="Revision" + font.replace("-", ""), fontsize=size,
                             color=color)
            x += length


# Normalize the full brand names, including tracked headers and footers.
for page in doc:
    edits = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line["spans"])
            if "™" not in text or page.number == 7 and text.startswith("Inside"):
                continue
            if text.startswith("Beauty Method"):
                revised = text.replace("Method™", "Method ™")
            elif text.startswith("A F"):
                revised = "THE ELEVATED ROUTINE  ·  The Elevated Beauty Method ™"
            elif text.startswith("F O U N D"):
                revised = "Founder, The Elevated Beauty Method ™"
            else:
                revised = "The Elevated Beauty Method ™"
            span = line["spans"][0]
            bbox = fitz.Rect(line["bbox"])
            right = 547 if page.number else 430
            if text.startswith("Beauty Method"):
                right = 552
            edits.append((bbox, revised, span["size"], span["font"], right))
    for bbox, text, size, font, right in edits:
        replace(page, bbox, text, size, font=font, height=size * 2, right=right,
                background=None if page.number == 0 else BLACK)

# Use the new publication name, retaining the original cover artwork and source files.
replace(doc[0], (72, 220, 540, 371), "The Elevated Routine",
        48, background=None, font="Cormorant", height=80, right=548, lineheight=1.2)
replace(doc[0], (72, 299, 540, 376),
        "How to Build a Skincare & Makeup Routine\nThat Fits Your Face and Your Life",
        24, background=None, font="Cormorant", height=77, right=548, lineheight=1.2)

for page, prefix, revised in [
    (doc[1], "This guide answers",
     "The Elevated Routine answers the ten questions I hear most often. Read it once straight "
     "through, then come back to the questions that speak to where you are right now. My hope "
     "is that you finish it with more clarity, more confidence, and more ease."),
    (doc[1], "H O W T O U S E T H I S G U I D E", "HOW TO USE THE ELEVATED ROUTINE"),
    (doc[8], "Everything in this guide",
     "Everything in The Elevated Routine, taught step by step — with me, live, every month."),
]:
    for block in page.get_text("dict")["blocks"]:
        lines = block.get("lines", [])
        first = "".join(span["text"] for span in lines[0]["spans"]) if lines else ""
        if first.startswith(prefix):
            span = lines[0]["spans"][0]
            # The source paragraph is split across separate PDF blocks.
            bbox = (64.7, 409, 547, 462) if prefix == "This guide answers" else lines[0]["bbox"]
            replace(page, bbox, revised, span["size"], font=span["font"],
                    height=span["size"] * (5 if prefix == "This guide answers" else 2),
                    right=547)
            break
    else:
        raise ValueError(f"Missing expected title reference: {prefix}")

replace(doc[7], (64.7, 304, 547, 342),
        "Inside The Elevated Beauty Method ™, everything is built around one framework, "
        "The Elevated Beauty Experience ™, that takes you from guessing to owning your look:",
        11.2, font="Lato-Light", height=43)
# The owner's screenshots, not the earlier rewritten draft, govern these passages.
# Extend only the Q3 callout's bottom to fit the requested additional words.
callout = doc[3].new_shape()
callout.draw_line((64.8, 227.184), (539.2, 227.184))
callout.draw_bezier((539.2, 227.184), (543.6, 227.184),
                   (547.2, 230.784), (547.2, 235.184))
callout.draw_line((547.2, 235.184), (547.2, 293))
callout.draw_bezier((547.2, 293), (547.2, 297.4), (543.6, 301), (539.2, 301))
callout.draw_line((539.2, 301), (64.8, 301))
callout.finish(fill=CALLOUT, color=None, closePath=True)
callout.commit()
doc[3].draw_rect((64.8, 227.184, 66.4, 301), fill=PINK, color=None)
replace_mari(doc[3], (79, 237, 535, 283),
        "COMING SOON · MARI V1 · Finding a complexion match in natural light is exactly what "
        "MARI V1, our first production release of our AI shade-matching tool, is being built to do. "
        "From a single photo, it will read your skin's undertones and match you to your ideal "
        "foundation and concealer shades. Founding Members get it first.",
        9.8, background=CALLOUT, height=62, body_font="Lato-Light")
replace(doc[5], (64.7, 108.4, 547, 132),
        "What should I do if my routine still isn't working?",
        19, font="Cormorant-Medium", height=32, lineheight=1.2)
replace_mari(doc[5], (79, 214, 535, 243),
        "COMING SOON · MARI V1 · If you suspect your shade is the problem, MARI V1 will soon take "
        "the guesswork out of it: one photo, and a match built from your own skin. "
        "Founding Members get it first.",
        9.8, background=CALLOUT, height=34, body_font="Lato-Light")
replace_mari(doc[8], (111.5, 424.5, 519, 440),
        "Priority access to MARI V1",
        10, background=PANEL, height=22)
doc[8].draw_line((87.5, 422), (87.5, 442), color=PINK, width=1.6)
replace(doc[8], (93.5, 247.3, 519, 274),
        "Founding rate: $24/month while your account stays in good standing. "
        "Standard membership: $48/month.",
        10, background=PANEL, height=36)
replace(doc[8], (93.5, 510, 519, 521),
        "Oct 1–7, 2026 · Limited to 50 places, subject to checkout availability.",
        10, background=PANEL, height=24)
replace(doc[8], (87, 633, 520, 662),
        "A free scorecard and routine check-in to reflect on your routine and goals. "
        "Complete the online Audit and verify your email to save your reflection.",
        10, height=34, font="Lato")

# Keep the Audit card's existing text and top border; extend its bottom for the CTA.
doc[8].draw_rect((64.3, 665, 547.7, 681), fill=BLACK, color=None)
border = doc[8].new_shape()
border.draw_line((64.8, 665), (64.8, 712))
border.draw_bezier((64.8, 712), (64.8, 720.8), (72, 728), (80.8, 728))
border.draw_line((80.8, 728), (531.2, 728))
border.draw_bezier((531.2, 728), (540, 728), (547.2, 720.8), (547.2, 712))
border.draw_line((547.2, 712), (547.2, 665))
border.finish(color=(47 / 255, 46 / 255, 43 / 255), width=0.8, closePath=False)
border.commit()
doc[8].draw_rect(AUDIT_BUTTON, fill=GOLD, color=None, radius=0.5)
label = "TAKE THE RADIANT AUDIT"
font = fitz.Font(fontbuffer=fonts["Lato-Bold"])
doc[8].insert_font(fontname="RevisionLatoBold", fontbuffer=fonts["Lato-Bold"])
tracking, size = 1.15, 9
widths = [font.text_length(char, fontsize=size) for char in label]
x = (AUDIT_BUTTON.x0 + AUDIT_BUTTON.x1 - sum(widths) - tracking * (len(label) - 1)) / 2
y = (AUDIT_BUTTON.y0 + AUDIT_BUTTON.y1) / 2 + (font.ascender + font.descender) * size / 2
for char, width in zip(label, widths):
    doc[8].insert_text((x, y), char, fontname="RevisionLatoBold", fontsize=size, color=BLACK)
    x += width + tracking

# The owner explicitly approved these production destinations.
for rect, uri in [
    ((93.6, 462, 345, 497), "https://elevatedbeautymethod.com/membership"),
    (AUDIT_BUTTON, "https://elevatedbeautymethod.com/radiant-audit"),
]:
    doc[8].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(rect), "uri": uri})

doc.set_metadata({
    **doc.metadata,
    "title": "The Elevated Routine — review copy",
    "subject": "Pending content and email-delivery approval; not published",
    "author": "Dominique",
})
DEST.parent.mkdir(parents=True, exist_ok=True)
doc.save(DEST, garbage=4, deflate=True)
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == EXPECTED_SHA
print(DEST)