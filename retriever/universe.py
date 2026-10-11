"""
ETF universe definitions for the US and Turkish (Borsa Istanbul) markets.

Nothing here requires an API key. Symbols follow Yahoo Finance conventions:
US ETFs use their bare ticker, Borsa Istanbul instruments use the ".IS" suffix.
"""

# --------------------------------------------------------------------------
# United States -- curated, liquid, category-tagged
# --------------------------------------------------------------------------
US_ETFS = [
    # Broad market
    ("SPY",   "Broad Market"),
    ("VOO",   "Broad Market"),
    ("IVV",   "Broad Market"),
    ("VTI",   "Broad Market"),
    ("QQQ",   "Broad Market"),
    ("QQQM",  "Broad Market"),
    ("DIA",   "Broad Market"),
    ("IWM",   "Broad Market"),
    ("RSP",   "Broad Market"),
    ("MDY",   "Broad Market"),
    # Style / factor
    ("VUG",   "Style & Factor"),
    ("VTV",   "Style & Factor"),
    ("IWF",   "Style & Factor"),
    ("IWD",   "Style & Factor"),
    ("SCHD",  "Style & Factor"),
    ("VYM",   "Style & Factor"),
    ("MTUM",  "Style & Factor"),
    ("QUAL",  "Style & Factor"),
    # Sectors
    ("XLK",   "Sector"),
    ("XLF",   "Sector"),
    ("XLE",   "Sector"),
    ("XLV",   "Sector"),
    ("XLY",   "Sector"),
    ("XLP",   "Sector"),
    ("XLI",   "Sector"),
    ("XLU",   "Sector"),
    ("XLB",   "Sector"),
    ("XLRE",  "Sector"),
    ("XLC",   "Sector"),
    ("SMH",   "Sector"),
    ("SOXX",  "Sector"),
    ("XBI",   "Sector"),
    ("KRE",   "Sector"),
    ("XOP",   "Sector"),
    ("ITA",   "Sector"),
    # Thematic
    ("ARKK",  "Thematic"),
    ("IGV",   "Thematic"),
    ("BOTZ",  "Thematic"),
    ("ICLN",  "Thematic"),
    ("SKYY",  "Thematic"),
    ("HACK",  "Thematic"),
    # International / emerging
    ("VEA",   "International"),
    ("VWO",   "International"),
    ("EFA",   "International"),
    ("EEM",   "International"),
    ("IEFA",  "International"),
    ("VXUS",  "International"),
    ("ACWI",  "International"),
    ("EWZ",   "International"),
    ("EWJ",   "International"),
    ("EWG",   "International"),
    ("MCHI",  "International"),
    ("INDA",  "International"),
    ("TUR",   "International"),   # iShares MSCI Turkey -- bridges both markets
    # Fixed income
    ("AGG",   "Fixed Income"),
    ("BND",   "Fixed Income"),
    ("TLT",   "Fixed Income"),
    ("IEF",   "Fixed Income"),
    ("SHY",   "Fixed Income"),
    ("LQD",   "Fixed Income"),
    ("HYG",   "Fixed Income"),
    ("TIP",   "Fixed Income"),
    ("SGOV",  "Fixed Income"),
    ("BIL",   "Fixed Income"),
    # Commodities & real assets
    ("GLD",   "Commodity & Real Asset"),
    ("IAU",   "Commodity & Real Asset"),
    ("SLV",   "Commodity & Real Asset"),
    ("GDX",   "Commodity & Real Asset"),
    ("USO",   "Commodity & Real Asset"),
    ("UNG",   "Commodity & Real Asset"),
    ("DBC",   "Commodity & Real Asset"),
    ("PDBC",  "Commodity & Real Asset"),
    ("VNQ",   "Commodity & Real Asset"),
    # Digital assets
    ("IBIT",  "Digital Asset"),
    ("FBTC",  "Digital Asset"),
    ("ETHA",  "Digital Asset"),
    # Income / derivative overlay
    ("JEPI",  "Options Income"),
    ("JEPQ",  "Options Income"),
    ("QYLD",  "Options Income"),
    # Leveraged & volatility
    ("TQQQ",  "Leveraged & Volatility"),
    ("SQQQ",  "Leveraged & Volatility"),
    ("UPRO",  "Leveraged & Volatility"),
    ("VIXY",  "Leveraged & Volatility"),
]

# --------------------------------------------------------------------------
# Turkey -- Borsa Istanbul BYF (Borsa Yatirim Fonu) market.
# Seed list; `discover.py` widens it and `fetch_etfs.py` drops dead symbols.
# --------------------------------------------------------------------------
TR_ETFS = [
    # Equity index
    ("ZPX30.IS", "Equity Index"),
    ("ISX30.IS", "Equity Index"),
    ("Z30KE.IS", "Equity Index"),
    ("Z30KP.IS", "Equity Index"),
    ("ISMDL.IS", "Equity Index"),
    ("DJIST.IS", "Equity Index"),
    ("ZBIST.IS", "Equity Index"),
    ("Z30EA.IS", "Equity Index"),
    # Dividend / thematic equity
    ("ZTM25.IS", "Dividend & Thematic"),
    ("ZELOT.IS", "Dividend & Thematic"),
    ("ZPLIB.IS", "Dividend & Thematic"),
    ("ZSR030.IS", "Dividend & Thematic"),
    ("ZRE20.IS", "Dividend & Thematic"),
    # Precious metals
    ("GLDTR.IS", "Precious Metal"),
    ("GMSTR.IS", "Precious Metal"),
    ("APGLD.IS", "Precious Metal"),
    ("ISGLK.IS", "Precious Metal"),
    ("ZGOLD.IS", "Precious Metal"),
    # Fixed income / money market
    ("FBIST.IS", "Fixed Income"),
    ("ZPBDL.IS", "Fixed Income"),
    ("ZPT10.IS", "Fixed Income"),
]

# Extra Borsa Istanbul candidates probed opportunistically. Anything that
# returns no price history is silently skipped, so over-listing is harmless.
TR_CANDIDATES = [
    "AKBYF.IS", "APETF.IS", "AKGLD.IS", "APGUM.IS", "APKAT.IS", "APTEK.IS",
    "ISBYF.IS", "ISKUR.IS", "ISY30.IS", "ISGUM.IS", "ISTEK.IS", "ISBNK.IS",
    "GRTHO.IS", "GPBYF.IS", "GUMUS.IS", "ALTIN.IS",
    "FYO.IS", "FNSBF.IS", "FDJIS.IS",
    "YKBYF.IS", "YKGLD.IS", "VKBYF.IS", "HLBYF.IS", "TEBBF.IS",
    "HDFGS.IS", "HEDEF.IS", "ISTBL.IS", "AZTBY.IS", "OYAKB.IS",
    "DNZBF.IS", "FIBBF.IS", "ALBBF.IS", "HSBBF.IS", "TCRBF.IS",
    "REPIE.IS", "NEOBF.IS", "GLBGG.IS", "ATLBF.IS", "ACTBF.IS",
    "STRBF.IS", "ANDBF.IS", "GDKBF.IS", "INFBF.IS", "OSMBF.IS",
    "TERBF.IS", "UNLBF.IS", "MRMBF.IS", "NASDQ.IS", "USDTR.IS",
    "TRYUS.IS", "ZKBMZ.IS", "ZPLKT.IS", "ZPKTL.IS", "ZPSTR.IS",
]

CATEGORY_FALLBACK = "Other"


def us_symbols():
    return [s for s, _ in US_ETFS]


def tr_symbols():
    return [s for s, _ in TR_ETFS]


def category_map():
    """symbol -> category label for every statically declared ETF."""
    m = {s: c for s, c in US_ETFS}
    m.update({s: c for s, c in TR_ETFS})
    return m
