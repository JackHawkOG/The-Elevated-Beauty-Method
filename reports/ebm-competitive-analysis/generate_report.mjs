import fs from "node:fs";
import { jsPDF } from "jspdf";

const OUT = "reports/ebm-competitive-analysis/ebm-competitive-analysis.pdf";
const PAGE_W = 612;
const PAGE_H = 792;
const M = 36;
const CONTENT_W = PAGE_W - M * 2;

const C = {
  ink: [20, 18, 16],
  cream: [245, 238, 224],
  gold: [226, 209, 171],
  muted: [112, 103, 91],
  line: [218, 210, 197],
  pale: [249, 246, 240],
  rose: [145, 91, 84],
  green: [47, 112, 84],
  amber: [173, 118, 54],
  white: [255, 255, 255],
};

const doc = new jsPDF({ unit: "pt", format: "letter" });

function fill(color) { doc.setFillColor(...color); }
function stroke(color) { doc.setDrawColor(...color); }
function textColor(color) { doc.setTextColor(...color); }

function pageBase(kicker, title, subtitle = "") {
  fill(C.pale);
  doc.rect(0, 0, PAGE_W, PAGE_H, "F");
  fill(C.ink);
  doc.rect(0, 0, PAGE_W, 104, "F");
  textColor(C.gold);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text(kicker.toUpperCase(), M, 33, { charSpace: 1.4 });
  textColor(C.cream);
  doc.setFont("times", "normal");
  doc.setFontSize(25);
  doc.text(title, M, 67);
  if (subtitle) {
    textColor([187, 178, 163]);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text(subtitle, M, 88);
  }
}

function sectionTitle(title, x, y, width = CONTENT_W) {
  textColor(C.ink);
  doc.setFont("times", "bold");
  doc.setFontSize(16);
  doc.text(title, x, y);
  stroke(C.gold);
  doc.setLineWidth(1.3);
  doc.line(x, y + 7, x + Math.min(width, 54), y + 7);
}

function body(text, x, y, width, options = {}) {
  const size = options.size ?? 9.3;
  const leading = options.leading ?? 13.2;
  textColor(options.color ?? C.muted);
  doc.setFont(options.font ?? "helvetica", options.style ?? "normal");
  doc.setFontSize(size);
  const lines = doc.splitTextToSize(text, width);
  doc.text(lines, x, y, { lineHeightFactor: leading / size });
  return y + lines.length * leading;
}

function bullet(text, x, y, width, options = {}) {
  fill(options.dot ?? C.gold);
  doc.circle(x + 3, y - 3, 2.2, "F");
  return body(text, x + 13, y, width - 13, options);
}

function card(x, y, w, h, title, copy, number) {
  fill(C.white);
  stroke(C.line);
  doc.roundedRect(x, y, w, h, 8, 8, "FD");
  fill(C.ink);
  doc.circle(x + 24, y + 25, 13, "F");
  textColor(C.gold);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(String(number), x + 24, y + 29, { align: "center" });
  textColor(C.ink);
  doc.setFont("times", "bold");
  doc.setFontSize(13);
  doc.text(doc.splitTextToSize(title, w - 58), x + 45, y + 23);
  body(copy, x + 18, y + 57, w - 36, { size: 8.3, leading: 11.3 });
}

// Page 1: Executive summary
pageBase("Competitive analysis", "The Elevated Beauty Method",
  "Reference: Natalie Setareh • Makeup education & transformation • September 2026");

sectionTitle("Executive summary", M, 137);
textColor(C.ink);
doc.setFont("times", "italic");
doc.setFontSize(15);
const positioning = "For women who want practical beauty confidence and greater visibility, The Elevated Beauty Method is an ongoing beauty-transformation community that combines makeup mastery, personal presence, and age-positive education. Unlike one-off tutorials and courses, EBM supports the woman she is becoming—not just the look she is learning.";
doc.text(doc.splitTextToSize(positioning, CONTENT_W), M, 169, { lineHeightFactor: 1.35 });

fill(C.gold);
doc.roundedRect(M, 278, CONTENT_W, 54, 7, 7, "F");
textColor(C.ink);
doc.setFont("helvetica", "bold");
doc.setFontSize(9);
doc.text("BOTTOM LINE", M + 16, 298);
doc.setFont("helvetica", "normal");
doc.setFontSize(9.2);
doc.text(doc.splitTextToSize(
  "Borrow Natalie’s specificity and proof—not her fragmented site structure. EBM can win by turning feature-specific makeup education into a guided, ongoing identity transformation.",
  CONTENT_W - 32), M + 16, 315);

sectionTitle("Three strategic moves", M, 373);
card(M, 398, 168, 218,
  "Create a tangible first win",
  "Launch a free “Elevated Everyday Face” path: skin type → undertone → feature mapping → five-minute look → day-to-night. A concrete result converts better than a broad library promise.",
  1);
card(M + 186, 398, 168, 218,
  "Personalize the method",
  "Use a short onboarding diagnostic to identify skin type, undertone, eye shape, life stage, and visibility goal. Turn the answers into a recommended path called “Your Method.”",
  2);
card(M + 372, 398, 168, 218,
  "Build proof into the product",
  "Replace generic social activity with named transformation stories, before/after learning outcomes, and role-specific testimonials from everyday women, founders, and women over 40.",
  3);

fill(C.ink);
doc.roundedRect(M, 646, CONTENT_W, 70, 8, 8, "F");
textColor(C.gold);
doc.setFont("times", "bold");
doc.setFontSize(13);
doc.text("Where EBM can own the category", M + 18, 670);
body("Premium beauty education for women in transition: practical enough to use tomorrow, emotionally resonant enough to change how they show up.", M + 18, 689, CONTENT_W - 36, { color: C.cream, size: 9.2 });

// Page 2: landscape
doc.addPage();
pageBase("01 / Landscape", "Competitive landscape",
  "Pricing and features reflect publicly visible pages accessed in September 2026.");

const landscapeRows = [
  ["EBM", "Working MVP", "$0 / $29 mo / $49 mo + $1,500", "Transformation + ongoing community", "Proof, pathways and entitlements not yet mature"],
  ["Natalie Setareh", "Independent educator", "$127 course; $9.99–$19.99 guides", "Specific, practical, inclusive curriculum", "Experience fragmented across site, shop and Thinkific"],
  ["YouTube / Instagram", "Mature platforms", "Free / ad-supported", "Infinite volume and convenience", "Low trust, weak personalization, product bias"],
  ["Sephora / Ulta classes", "Retail education", "Often free or low-cost", "Hands-on help and product trial", "Retail sales incentive; weak continuity"],
  ["Online pro academies", "Established schools", "From ~$49/mo; higher total tuition", "Structure, feedback and certification", "Career-led; excessive for everyday learners"],
];

const cols = [88, 85, 108, 126, 133];
const x0 = M;
let y = 137;
const headers = ["Alternative", "Stage", "Public price", "Primary strength", "Primary weakness"];
fill(C.ink);
doc.rect(x0, y, CONTENT_W, 30, "F");
let x = x0;
headers.forEach((h, i) => {
  textColor(C.cream);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.text(h.toUpperCase(), x + 6, y + 19);
  x += cols[i];
});
y += 30;
landscapeRows.forEach((row, ri) => {
  const h = 77;
  fill(ri % 2 === 0 ? C.white : [246, 242, 235]);
  doc.rect(x0, y, CONTENT_W, h, "F");
  x = x0;
  row.forEach((value, i) => {
    textColor(i === 0 ? C.ink : C.muted);
    doc.setFont("helvetica", i === 0 ? "bold" : "normal");
    doc.setFontSize(i === 0 ? 8.5 : 7.7);
    doc.text(doc.splitTextToSize(value, cols[i] - 12), x + 6, y + 18, { lineHeightFactor: 1.28 });
    stroke(C.line);
    doc.line(x + cols[i], y, x + cols[i], y + h);
    x += cols[i];
  });
  y += h;
});

sectionTitle("What the reference proves", M, 586);
bullet("Specific outcomes create trust: skin type, undertone, face and eye shape, a five-day sequence, a workbook, video instruction, support, and one-year access.", M, 612, CONTENT_W);
bullet("Natalie’s own testimonials emphasize confidence, faster routines, smarter product shopping, and advice suited to the individual—not trend imitation.", M, 654, CONTENT_W);
bullet("No independent review corpus was found for Natalie’s course; the proof cited here is seller-published and should be treated as directional.", M, 696, CONTENT_W, { dot: C.rose });

// Page 3: feature matrix
doc.addPage();
pageBase("02 / Product", "Feature matrix",
  "● strong / live   ◐ partial / planned   ○ absent or not evident   • Weight = buyer importance (1–5)");

const matrix = [
  ["Skin type & undertone", 5, "◐", "●", "◐", "◐", "●"],
  ["Face / eye feature mapping", 5, "◐", "●", "◐", "◐", "●"],
  ["Clear beginner pathway", 5, "◐", "●", "○", "◐", "●"],
  ["Identity & confidence work", 5, "●", "◐", "○", "○", "◐"],
  ["Age-positive beauty", 4, "●", "◐", "◐", "◐", "◐"],
  ["Visibility / camera presence", 4, "●", "◐", "◐", "○", "◐"],
  ["Ongoing community", 4, "●", "◐", "◐", "○", "●"],
  ["Progress tracking", 4, "●", "●", "◐", "○", "●"],
  ["Digital guides / workbook", 4, "◐", "●", "○", "○", "◐"],
  ["Visible customer proof", 5, "○", "●", "◐", "◐", "●"],
  ["Tiered recurring membership", 3, "◐", "○", "○", "○", "◐"],
  ["Personalized support", 4, "◐", "●", "○", "●", "●"],
];

const mCols = [181, 37, 62, 72, 62, 62, 64];
const mHeaders = ["Capability", "Wt.", "EBM", "Natalie", "Social", "Retail", "Pro"];
y = 137; x = M;
fill(C.ink); doc.rect(M, y, CONTENT_W, 32, "F");
mHeaders.forEach((h, i) => {
  textColor(C.cream); doc.setFont("helvetica", "bold"); doc.setFontSize(7);
  doc.text(h.toUpperCase(), x + (i < 2 ? 6 : mCols[i] / 2), y + 20, { align: i < 2 ? "left" : "center" });
  x += mCols[i];
});
y += 32;
matrix.forEach((row, ri) => {
  const h = 39;
  fill(ri % 2 === 0 ? C.white : [247, 243, 237]); doc.rect(M, y, CONTENT_W, h, "F");
  x = M;
  row.forEach((value, i) => {
    const symbol = String(value);
    let color = C.muted;
    if (i >= 2 && symbol === "●") color = C.green;
    if (i >= 2 && symbol === "◐") color = C.amber;
    if (i >= 2 && symbol === "○") color = C.rose;
    textColor(i === 0 ? C.ink : color);
    doc.setFont("helvetica", i === 0 ? "bold" : "normal");
    doc.setFontSize(i >= 2 ? 12 : 8.2);
    doc.text(symbol, x + (i < 2 ? 6 : mCols[i] / 2), y + 24, { align: i < 2 ? "left" : "center" });
    stroke(C.line); doc.line(x + mCols[i], y, x + mCols[i], y + h);
    x += mCols[i];
  });
  y += h;
});

fill([239, 231, 215]);
doc.roundedRect(M, 676, CONTENT_W, 46, 6, 6, "F");
body("Priority gap: EBM already has the broadest transformation proposition, but Natalie currently communicates the learning journey and individual relevance more convincingly.", M + 14, 696, CONTENT_W - 28, { color: C.ink, size: 8.8, style: "bold" });

// Page 4: positioning map
doc.addPage();
pageBase("03 / Positioning", "The white-space position",
  "The attractive corner combines individual relevance with an ongoing transformation ecosystem.");

const chartData = fs.readFileSync("reports/ebm-competitive-analysis/positioning-map.png").toString("base64");
doc.addImage(`data:image/png;base64,${chartData}`, "PNG", M, 130, CONTENT_W, 356);

sectionTitle("Interpretation", M, 528);
bullet("Natalie is strong on personalization to the learner, but the experience is primarily a course-and-guide funnel rather than a recurring identity community.", M, 553, CONTENT_W);
bullet("Pro academies provide structure and feedback, but their career and certification emphasis overshoots the everyday woman’s job-to-be-done.", M, 593, CONTENT_W);
bullet("EBM can occupy the premium upper-right by making its promised transformation operational: diagnostic onboarding, guided pathways, live support, and member milestones.", M, 633, CONTENT_W);

fill(C.ink);
doc.roundedRect(M, 687, CONTENT_W, 42, 6, 6, "F");
body("Own this phrase: “The method for how you look, feel, and show up.”", M + 15, 711, CONTENT_W - 30, { color: C.gold, size: 11, font: "times", style: "bold" });

// Page 5: white space and Kano
doc.addPage();
pageBase("04 / Opportunity", "White space & Kano analysis",
  "What the category expects, what improves preference, and what can make EBM memorable.");

sectionTitle("Three under-served opportunities", M, 137);
card(M, 162, 168, 190, "Life-stage pathways",
  "Organize the same core beauty skills around real moments: Everyday Elevation, On-Camera Visibility, Reinvention After 40, and Artist-to-Expert.",
  1);
card(M + 186, 162, 168, 190, "Prestige without intimidation",
  "Combine the polish of a luxury beauty brand with beginner-safe language, practical shopping guidance, and visible “start here” direction.",
  2);
card(M + 372, 162, 168, 190, "Practice-to-presence loop",
  "Move beyond watching videos: complete a look, reflect on confidence, share a result, receive feedback, and apply it in a real visibility moment.",
  3);

sectionTitle("Kano map", M, 397);
const kano = [
  ["BASICS", C.rose, "Clear curriculum • mobile-ready video • progress • accessible captions • secure account • explicit tier access"],
  ["PERFORMANCE", C.amber, "More personalization • faster feedback • stronger workbooks • longer access • better search • more live sessions"],
  ["DELIGHTERS", C.green, "Beauty identity profile • visibility rehearsals • age-positive pathways • reinvention circles • camera-look reviews"],
];
y = 426;
kano.forEach(([label, color, copy]) => {
  fill(color);
  doc.roundedRect(M, y, 94, 60, 6, 6, "F");
  textColor(C.white); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  doc.text(label, M + 47, y + 35, { align: "center" });
  fill(C.white); stroke(C.line); doc.roundedRect(M + 104, y, CONTENT_W - 104, 60, 6, 6, "FD");
  body(copy, M + 120, y + 23, CONTENT_W - 136, { color: C.ink, size: 8.6, leading: 12 });
  y += 76;
});

// Page 6: action plan
doc.addPage();
pageBase("05 / Action", "90-day action plan",
  "Sequence matters: prove a first transformation before expanding the catalog.");

const actions = [
  {
    phase: "DAYS 1–30",
    title: "Build the “Start Here” conversion path",
    copy: "Add a five-question beauty diagnostic and a free five-part Elevated Everyday Face pathway. Show the exact lesson sequence before sign-up. End with one concrete deliverable: a repeatable 10-minute look.",
    metric: "Primary metric: diagnostic completion → free membership conversion",
  },
  {
    phase: "DAYS 31–60",
    title: "Make membership differences tangible",
    copy: "Label every course and resource by tier. Add locked previews, upgrade prompts, and a comparison view that explains outcomes—not just content quantity. Connect the $29 tier to workshops and feedback; reserve transformation intensives for premium.",
    metric: "Primary metric: free → $29 trial or subscription intent",
  },
  {
    phase: "DAYS 61–90",
    title: "Install the transformation proof loop",
    copy: "Collect structured member stories at enrollment and after key milestones. Ask what changed in routine, product confidence, camera comfort, and willingness to be seen. Feature proof beside the relevant pathway.",
    metric: "Primary metric: pathway completion + usable transformation stories",
  },
];

y = 142;
actions.forEach((a, i) => {
  fill(C.white); stroke(C.line); doc.roundedRect(M, y, CONTENT_W, 133, 8, 8, "FD");
  fill(i === 0 ? C.gold : C.ink); doc.roundedRect(M, y, 104, 133, 8, 8, "F");
  textColor(i === 0 ? C.ink : C.gold); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  doc.text(a.phase, M + 52, y + 50, { align: "center" });
  doc.setFont("times", "bold"); doc.setFontSize(24);
  doc.text(`0${i + 1}`, M + 52, y + 84, { align: "center" });
  textColor(C.ink); doc.setFont("times", "bold"); doc.setFontSize(14);
  doc.text(a.title, M + 124, y + 29);
  body(a.copy, M + 124, y + 52, CONTENT_W - 144, { size: 8.5, leading: 11.6 });
  body(a.metric, M + 124, y + 112, CONTENT_W - 144, { size: 7.8, color: C.green, style: "bold" });
  y += 149;
});

sectionTitle("Trap-setting questions", M, 610);
bullet("Are you looking for another tutorial—or a method tailored to your features, season of life, and visibility goals?", M, 635, CONTENT_W);
bullet("What happens after you finish the course: do you keep growing, receive feedback, and have a community to return to?", M, 670, CONTENT_W);
bullet("Are you only learning makeup, or are you preparing to show up differently in your business, relationships, and next chapter?", M, 705, CONTENT_W);

// Page 7: sources
doc.addPage();
pageBase("06 / Evidence", "Sources & confidence notes",
  "Public pages accessed September 2026. Pricing and product details may change.");

const sources = [
  ["1", "Natalie Setareh — 7 Ways to Learn Makeup at Home", "https://nataliesetareh.com/learn-makeup-at-home/"],
  ["2", "Natalie Setareh — Learn Makeup in 5 Days", "https://nataliesetareh.com/learnmakeup"],
  ["3", "Natalie Setareh — Makeup Learning Lab / Shop", "https://nataliesetareh.com/shop"],
  ["4", "Natalie Setareh — Makeup for Beginners guide", "https://nataliesetareh.com/makeup-for-beginners"],
  ["5", "Thinkific — Learn Makeup in 5 Days curriculum", "https://makeupforbeginners.thinkific.com/courses/learn"],
  ["6", "Create Your Signature Look — Makeup coaching", "https://createyoursignaturelook.com/makeup"],
  ["7", "QC Makeup Academy — Online makeup courses", "https://www.qcmakeupacademy.com/online-makeup-courses"],
  ["8", "Online Makeup Academy — Programs and tuition", "https://www.onlinemakeupacademy.com/programs-and-tuition"],
  ["9", "EBM working product — current app and supplied membership brief", "Current Replit project and user-provided source document"],
];

y = 137;
sources.forEach(([n, title, url]) => {
  fill(C.ink); doc.circle(M + 12, y + 9, 11, "F");
  textColor(C.gold); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  doc.text(n, M + 12, y + 12, { align: "center" });
  textColor(C.ink); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  doc.text(title, M + 34, y + 5);
  body(url, M + 34, y + 21, CONTENT_W - 34, { size: 7.2, leading: 9.5, color: C.muted });
  y += 57;
});

fill([239, 231, 215]);
doc.roundedRect(M, 664, CONTENT_W, 63, 7, 7, "F");
textColor(C.ink); doc.setFont("helvetica", "bold"); doc.setFontSize(8);
doc.text("CONFIDENCE NOTE", M + 14, 684);
body("Natalie’s strengths and testimonials are based primarily on her own public pages; no meaningful independent review corpus was found. The positioning map and feature ratings are analyst judgments, clearly separated from sourced facts.", M + 14, 701, CONTENT_W - 28, { color: C.ink, size: 8 });

// Add consistent headers/footers without altering any content cursor.
const total = doc.getNumberOfPages();
for (let i = 1; i <= total; i++) {
  doc.setPage(i);
  const savedPage = i;
  stroke(C.line);
  doc.setLineWidth(0.5);
  doc.line(M, 754, PAGE_W - M, 754);
  textColor(C.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text("THE ELEVATED BEAUTY METHOD • COMPETITIVE ANALYSIS", M, 772);
  doc.text(`${savedPage} / ${total}`, PAGE_W - M, 772, { align: "right" });
}

fs.mkdirSync("reports/ebm-competitive-analysis", { recursive: true });
fs.writeFileSync(OUT, Buffer.from(doc.output("arraybuffer")));
console.log(`Wrote ${OUT} with ${doc.getNumberOfPages()} pages`);
