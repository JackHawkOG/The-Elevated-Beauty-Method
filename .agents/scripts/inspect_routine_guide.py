from pathlib import Path
import fitz

source = Path("attached_assets/Elevated-Routine-Guide_1790514157477.pdf")
output = Path(".agents/outputs/routine-guide")
output.mkdir(parents=True, exist_ok=True)
doc = fitz.open(source)
for number, page in enumerate(doc, start=1):
    page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(output / f"page-{number}.png")
    print(f"PAGE {number} ({page.rect.width} x {page.rect.height}) links={page.get_links()}")
    print(page.get_text())