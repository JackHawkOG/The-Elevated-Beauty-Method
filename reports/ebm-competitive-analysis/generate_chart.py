import matplotlib.pyplot as plt

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "axes.facecolor": "#0D0D0B",
    "figure.facecolor": "#0D0D0B",
    "text.color": "#F5EEE0",
    "axes.labelcolor": "#F5EEE0",
    "xtick.color": "#A99F8D",
    "ytick.color": "#A99F8D",
    "axes.edgecolor": "#4A4337",
})

fig, ax = plt.subplots(figsize=(9, 6), dpi=180)

points = [
    ("The Elevated Beauty Method", 8.7, 8.9, "#FFECC2", 180),
    ("Natalie Setareh", 8.1, 4.8, "#C99A76", 135),
    ("Pro academies", 5.1, 6.7, "#A39575", 115),
    ("Sephora / Ulta classes", 5.8, 2.5, "#7D7465", 110),
    ("YouTube / Instagram", 2.6, 1.8, "#6B655C", 110),
]

for label, x, y, color, size in points:
    ax.scatter(x, y, s=size, color=color, edgecolor="#0D0D0B", linewidth=1.2, zorder=3)
    if label == "The Elevated Beauty Method":
        ax.annotate(label, (x, y), xytext=(-12, -22), textcoords="offset points",
                    ha="right", fontsize=9, fontweight="bold", color=color)
    elif label == "Natalie Setareh":
        ax.annotate(label, (x, y), xytext=(-10, 10), textcoords="offset points",
                    ha="right", fontsize=9, color="#F5EEE0")
    else:
        ax.annotate(label, (x, y), xytext=(9, 7), textcoords="offset points",
                    fontsize=8, color="#D5CBBB")

ax.axvline(5, color="#4A4337", linewidth=0.8)
ax.axhline(5, color="#4A4337", linewidth=0.8)
ax.grid(color="#24211C", linewidth=0.6, alpha=0.9)
ax.set_xlim(0, 10)
ax.set_ylim(0, 10)
ax.set_xlabel("LOW  ←  PERSONALIZATION TO THE WOMAN  →  HIGH", labelpad=12, fontsize=9)
ax.set_ylabel("LOW  ←  ONGOING TRANSFORMATION ECOSYSTEM  →  HIGH", labelpad=12, fontsize=9)
ax.set_xticks([0, 2, 4, 6, 8, 10])
ax.set_yticks([0, 2, 4, 6, 8, 10])
ax.set_title("Positioning opportunity", loc="left", fontsize=15, fontweight="bold", pad=18)
ax.text(0.1, 10.35, "Analyst assessment based on public product pages; not a customer survey.",
        fontsize=7.5, color="#A99F8D")

for spine in ax.spines.values():
    spine.set_linewidth(0.8)

plt.tight_layout()
plt.savefig("reports/ebm-competitive-analysis/positioning-map.png",
            facecolor=fig.get_facecolor(), bbox_inches="tight")
