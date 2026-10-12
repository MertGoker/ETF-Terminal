"""
Category for a US-listed ETF, inferred from its official name.

The Nasdaq symbol directory gives a ticker, a name and an exchange -- no
sector or asset class. With two thousand funds, leaving them all in one
"Other" bucket makes the sector filter useless, so the name is classified
here. Fund names are highly conventional ("...2X Long...", "...Treasury
Bond...", "...Semiconductor..."), which is what makes this tractable.

Order matters: leverage and options overlays are checked before the asset
class, because "Direxion Daily Semiconductor Bull 3X" is a leveraged product
first and a sector fund second.
"""
from __future__ import annotations

import re

RULES: list[tuple[str, str]] = [
    ("Leveraged & Volatility",
     r"\b(?:[23](?:\.\d)?x|ultra(?:pro|short)?|leverage[d]?|inverse|bear|bull\b|"
     r"daily\s+\w+\s+(?:bull|bear)|vix|volatility|short\s+\w+\s+daily)\b"),
    ("Options Income",
     r"\b(?:covered\s*call|buy ?write|buffer|premium\s+income|option\s+income|"
     r"target\s+income|yieldmax|defined\s+outcome|collar)\b"),
    ("Digital Asset",
     r"\b(?:bitcoin|ether(?:eum)?|crypto|blockchain|digital\s+asset|solana|xrp)\b"),
    ("Fixed Income",
     r"\b(?:bond|treasury|t-bill|bills?|aggregate|credit|municipal|muni|"
     r"high\s+yield|investment\s+grade|duration|tips|clo|mbs|securitized|"
     r"fixed\s+income|ultrashort|floating\s+rate|loan|cash)\b"),
    ("Commodity & Real Asset",
     r"\b(?:gold|silver|platinum|palladium|copper|lithium|uranium|oil|"
     r"natural\s+gas|energy\s+commodity|commodit|metals?|agricultur|"
     r"real\s+estate|reit|infrastructure|timber|carbon)\b"),
    ("International",
     r"\b(?:emerging|international|developed|ex[- ]u\.?s\.?|global|world|"
     r"china|japan|europe|india|brazil|korea|taiwan|mexico|vietnam|"
     r"latin\s+america|asia|pacific|eafe|acwi|frontier)\b"),
    ("Sector",
     r"\b(?:technology|semiconductor|software|internet|health ?care|biotech|"
     r"pharmaceutical|financial|bank|insurance|energy|utilit|industrial|"
     r"consumer|materials|communication|aerospace|defen[cs]e|transport|"
     r"retail|homebuilder|gaming|cannabis|airline)\b"),
    ("Style & Factor",
     r"\b(?:growth|value|momentum|quality|dividend|low\s+volatility|"
     r"equal\s+weight|factor|multifactor|small[- ]cap|mid[- ]cap|large[- ]cap|"
     r"micro[- ]cap|esg|sustainab)\b"),
    ("Broad Market",
     r"\b(?:s&p\s*500|total\s+(?:stock\s+)?market|russell|nasdaq[- ]?100|"
     r"dow\s+jones|broad\s+market|core\s+(?:s&p|equity)|500\s+index|"
     r"total\s+(?:us|u\.s\.)\s+)"),
]
COMPILED = [(name, re.compile(pat, re.I)) for name, pat in RULES]
DEFAULT = "Thematic"


def classify(name: str) -> str:
    text = name or ""
    for category, pat in COMPILED:
        if pat.search(text):
            return category
    return DEFAULT
