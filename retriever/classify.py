"""
Two-level classification for a fund, inferred from its official name.

Neither source ships a sector: the Nasdaq symbol directory gives a ticker and
a name, TEFAS gives a broad fund type. With nearly eight thousand funds a
single flat list is unusable, so each fund gets two labels:

    category -- one of ten broad buckets, for grouping
    theme    -- what the fund actually holds: "Semiconductors", "Gold Miners",
                "Long Treasuries", "Bitcoin", "Covered Call", ...

Order is everything. A leveraged semiconductor fund is a leveraged product
first, so the structure rules (leverage, options overlays, target maturity)
are tested before the asset class, and narrow themes before the broad ones
they sit inside -- "AI" before "Software", "Gold Miners" before "Gold".
"""
from __future__ import annotations

import re

# (theme, category, pattern) in priority order.
RULES: list[tuple[str, str, str]] = [
    # ---- structure: how the fund is built, regardless of what it holds ----
    ("Single-Stock Leveraged", "Leveraged & Volatility",
     r"\b(?:[12345](?:\.\d)?x\s+(?:long|short|daily)|daily\s+[12345]x)\b.{0,30}\b(?:nvda|tsla|aapl|msft|amzn|googl?|meta|amd|coin|mstr|pltr|nflx|avgo|smci|hood|mu)\b"),
    ("Leveraged Long", "Leveraged & Volatility",
     r"\b(?:ultrapro|ultra\b|[23](?:\.\d)?x\s*(?:long|bull|shares)?|bull\s+[23]x|leveraged\s+long)\b"),
    ("Inverse & Short", "Leveraged & Volatility",
     r"\b(?:inverse|ultrashort|bear\s+[23]?x?|short\s+(?:daily|[23]x)|[23]x\s+short|-1x|short\s+\w+\s+daily)\b"),
    ("Volatility", "Leveraged & Volatility", r"\b(?:vix|volatility\s+index|vstoxx)\b"),
    ("Covered Call", "Options Income",
     r"\b(?:covered\s*call|buy\s?write|call\s+writing|overwrit)"),
    ("Buffer & Defined Outcome", "Options Income",
     r"\b(?:buffer|defined\s+outcome|floor\b|collar|accelerated\s+return|power\s+buffer)"),
    ("Options Premium Income", "Options Income",
     r"\b(?:premium\s+income|option\s+income|yieldmax|target\s+income|credit\s+spread|put\s+write)"),
    ("Target Maturity Bonds", "Fixed Income",
     r"\b(?:ibonds|bulletshares|target\s+maturity|20\d\d\s+(?:term|maturity|corporate|municipal|treasury))\b"),

    # ---- digital assets ----
    ("Bitcoin", "Digital Asset", r"\bbitcoin|\bbtc\b"),
    ("Ethereum", "Digital Asset", r"\bether(?:eum)?\b|\beth\b"),
    ("Other Crypto", "Digital Asset",
     r"\bsolana|\bxrp\b|\bripple|\bdogecoin|\blitecoin|\baltcoin|\bcrypto\s+index|\bzcash|"
     r"\bhyperliquid|\bchainlink|\bcardano|\bavalanche|\bpolkadot|\bstaking\b|\bsui\b"),
    ("Blockchain & Crypto Equity", "Digital Asset",
     r"\b(?:blockchain|digital\s+asset|crypto\s+(?:industry|economy|miners?)|miners?\s+index)\b"),

    # ---- technology themes, narrow before broad ----
    ("Semiconductors", "Sector", r"\b(?:semiconductor|chip(?:makers?)?|soxx?|microchip)\b"),
    ("Artificial Intelligence", "Sector",
     r"\b(?:artificial\s+intelligence|\bai\b|machine\s+learning|generative)\b"),
    ("Robotics & Automation", "Sector", r"\brobotic|\bautomation|\bdrone"),
    ("Quantum Computing", "Sector", r"\bquantum\b"),
    ("Cybersecurity", "Sector", r"\b(?:cyber ?security|cyber\b|information\s+security)\b"),
    ("Cloud & Software", "Sector", r"\b(?:cloud|software|saas|enterprise\s+tech)\b"),
    ("Internet & E-commerce", "Sector", r"\b(?:internet|e-?commerce|online\s+retail|web\b)\b"),
    ("Fintech & Payments", "Sector", r"\b(?:fintech|payments?|financial\s+technology)\b"),
    ("Gaming & Esports", "Sector", r"\bvideo\s+gam|\besports|\bgaming|\bmetaverse"),
    ("Media & Entertainment", "Sector", r"\b(?:media|entertainment|streaming)\b"),
    ("Telecom", "Sector", r"\b(?:telecom|communication\s+services|wireless|5g)\b"),
    ("Space", "Sector", r"\b(?:space|satellite|orbital)\b"),
    ("Photonics & Optics", "Sector", r"\bphotonic|\boptic(?:s|al)\b|\blaser"),
    ("Next-Gen Connectivity", "Sector", r"\bnextg\b|\bnext\s+g(?:en)?\b|\b5g\b|\bedge\s+comput"),
    ("Data & Surveillance", "Sector", r"\bsurveillance|\bbig\s+data|\bdata\s+(?:center|infrastructure)"),
    ("Technology (Broad)", "Sector",
     r"\btechnolog|\btech\s+(?:sector|leader)|\binfo(?:rmation)?\s+tech|\bdisruptive|\binnovat"),

    # ---- health care ----
    ("Biotechnology", "Sector", r"\bbiotech|\bgenomic|\bgene\s+(?:editing|therapy)"),
    ("Pharmaceuticals", "Sector", r"\bpharmaceutical|\bpharma\b|\bdrug\b"),
    ("Medical Devices", "Sector", r"\bmedical\s+(?:device|equipment)|\bmedtech\b"),
    ("Health Care (Broad)", "Sector", r"\bhealth\s?care|\bhealth\b|\bhospital|\blife\s+science"),

    # ---- financials & real estate ----
    ("Banks", "Sector", r"\b(?:bank(?:s|ing)?|regional\s+bank)\b"),
    ("Insurance", "Sector", r"\binsurance\b"),
    ("Capital Markets", "Sector", r"\bbroker|\basset\s+manager|\bcapital\s+markets|\bexchanges?\b|\bbdc\b|\bbusiness\s+development"),
    ("REITs & Real Estate", "Commodity & Real Asset",
     r"\breit|\breal\s+estate|\bproperty"),

    # ---- energy & resources ----
    ("Gold Miners", "Commodity & Real Asset", r"\bgold\s+(?:miner|mining)|\bminers?\b.{0,12}gold"),
    ("Gold", "Commodity & Real Asset", r"\bgold\b|\bbullion\b"),
    ("Silver", "Commodity & Real Asset", r"\bsilver\b"),
    ("Platinum & Palladium", "Commodity & Real Asset", r"\bplatinum|\bpalladium"),
    ("Copper", "Commodity & Real Asset", r"\bcopper\b"),
    ("Lithium & Battery", "Sector", r"\blithium|\bbattery|\bbatteries"),
    ("Uranium & Nuclear", "Sector", r"\buranium|\bnuclear\b"),
    ("Solar", "Sector", r"\bsolar\b"),
    ("Wind", "Sector", r"\bwind\s+(?:energy|power)|\bwind\b"),
    ("Hydrogen", "Sector", r"\bhydrogen|\bfuel\s+cell"),
    ("Clean Energy", "Sector", r"\b(?:clean\s+energy|renewable|green\s+energy|alternative\s+energy)\b"),
    ("Crude Oil", "Commodity & Real Asset", r"\b(?:crude|oil\s+fund|wti|brent)\b"),
    ("Natural Gas", "Commodity & Real Asset", r"\bnatural\s+gas\b"),
    ("Oil & Gas Equity", "Sector",
     r"\b(?:oil\s*&?\s*gas|energy\s+(?:sector|select|equip)|exploration|oilfield|midstream|pipeline|mlp)\b"),
    ("Coal", "Sector", r"\bcoal\b"),
    ("Agriculture", "Commodity & Real Asset", r"\bagricultur|\bfarmland|\bcorn\b|\bwheat\b|\bsoybean|\blivestock|\bcocoa\b|\bcoffee\b|\bsugar\b"),
    ("Broad Commodity", "Commodity & Real Asset", r"\bcommodit|\bmetals?\s+index|\bcarbon\b|\btimber"),
    ("Steel & Mining", "Sector", r"\b(?:steel|mining|rare\s+earth|aluminum|iron\s+ore)\b"),
    ("Materials", "Sector", r"\bmaterials\b|\bchemical"),

    # ---- industrials & consumer ----
    ("Aerospace & Defense", "Sector", r"\b(?:aerospace|defen[cs]e|military)\b"),
    ("Airlines", "Sector", r"\bairline|\baviation\b"),
    ("Shipping & Logistics", "Sector", r"\b(?:shipping|logistics|freight|maritime|tanker)\b"),
    ("Autos & EV", "Sector", r"\b(?:electric\s+vehicle|\bev\b|automotive|autos?\b|autonomous)\b"),
    ("Homebuilders & Housing", "Sector", r"\b(?:homebuilder|housing|home\s+construction)\b"),
    ("Infrastructure", "Sector", r"\binfrastructure\b"),
    ("Industrials", "Sector", r"\bindustrial|\bmanufactur|\btransport|\brailroad"),
    ("Retail", "Sector", r"\bretail\b|\bdepartment\s+store"),
    ("Restaurants & Travel", "Sector", r"\b(?:restaurant|travel|leisure|hotel|cruise|casino)\b"),
    ("Cannabis", "Sector", r"\bcannabis|\bmarijuana|\bpsychedelic"),
    ("Consumer Staples", "Sector", r"\bconsumer\s+staple|\bfood\s*&?\s*beverage|\bhousehold"),
    ("Consumer Discretionary", "Sector", r"\bconsumer\s+discretionary|\bconsumer\b"),
    ("Utilities", "Sector", r"\butilit"),
    ("Water", "Sector", r"\bwater\b"),

    # ---- fixed income, specific before broad ----
    ("TIPS & Inflation", "Fixed Income", r"\btips\b|\binflation[- ]protect|\breal\s+return"),
    ("Long Treasuries", "Fixed Income", r"\b(?:20\+?\s*year|long[- ]term\s+treasur|25\+?\s*year|extended\s+duration)\b"),
    ("Short Treasuries", "Fixed Income",
     r"\b(?:1-3\s*(?:month|year)|0-3\s*month|short[- ]term\s+treasur|t-?bill|treasury\s+bill|ultra\s*short)\b"),
    ("US Treasuries", "Fixed Income", r"\btreasur|\bgovernment\s+bond|\bgnma\b|\bagency\b"),
    ("Municipal Bonds", "Fixed Income", r"\bmunicipal|\bmuni\b|\btax[- ]exempt"),
    ("High Yield", "Fixed Income", r"\bhigh[- ]yield|\bjunk\b|\bfallen\s+angel"),
    ("Bank Loans & CLO", "Fixed Income", r"\bclo\b|\bsenior\s+loan|\bbank\s+loan|\bleveraged\s+loan|\bfloating\s+rate"),
    ("Securitized & MBS", "Fixed Income", r"\bmbs\b|\bmortgage[- ]backed|\bsecuritiz|\basset[- ]backed|\babs\b"),
    ("Investment Grade Credit", "Fixed Income", r"\binvestment[- ]grade|\bcorporate\s+bond|\bcredit\b"),
    ("Emerging Market Debt", "Fixed Income", r"\bemerging\s+market\s+(?:bond|debt|local)"),
    ("International Bonds", "Fixed Income", r"\binternational\s+bond|\bglobal\s+bond|\bex[- ]u\.?s\.?\s+bond"),
    ("Preferred & Convertible", "Fixed Income", r"\bpreferred\b|\bconvertible\b"),
    ("Cash & Money Market", "Fixed Income", r"\bmoney\s+market|\bcash\s+management|\benhanced\s+cash"),
    ("Aggregate Bond", "Fixed Income", r"\baggregate\b|\btotal\s+bond|\bcore\s+bond|\bbond\s+market"),
    ("Bonds (Other)", "Fixed Income", r"\bbond|\bfixed\s+income|\bduration\b|\byield\s+curve"),

    # ---- countries and regions ----
    ("China", "International", r"\bchina\b|\bchinese\b|\bhong\s+kong\b|\bcsi\s*300\b"),
    ("Japan", "International", r"\bjapan"),
    ("India", "International", r"\bindia\b"),
    ("Korea", "International", r"\bkorea"),
    ("Taiwan", "International", r"\btaiwan"),
    ("Vietnam", "International", r"\bvietnam"),
    ("Brazil", "International", r"\bbrazil"),
    ("Mexico", "International", r"\bmexico|\bmexican"),
    ("Latin America", "International", r"\blatin\s+america|\bandean\b|\bchile\b|\bcolombia|\bperu\b|\bargentin"),
    ("Canada", "International", r"\bcanad"),
    ("United Kingdom", "International", r"\bunited\s+kingdom|\bu\.?k\.?\b|\bbritain"),
    ("Germany", "International", r"\bgerman"),
    ("Europe", "International", r"\beurope|\beurozone|\beuro\s+stoxx|\bemu\b"),
    ("Israel", "International", r"\bisrael"),
    ("Asia Pacific", "International", r"\basia|\bpacific\b|\basean\b"),
    ("Emerging Markets", "International", r"\bemerging\b|\bfrontier\b"),
    ("Developed ex-US", "International", r"\beafe\b|\bdeveloped\s+(?:markets?|ex)|\bex[- ]u\.?s\.?\b|\bex[- ]us\b"),
    ("Global & World", "International", r"\bglobal\b|\bworld\b|\bacwi\b|\binternational\b|\bforeign\b"),

    # ---- style and factor ----
    ("Dividend", "Style & Factor", r"\bdividend|\bincome\s+equity|\bpayout|\baristocrat"),
    ("Buyback", "Style & Factor", r"\bbuyback|\bshareholder\s+yield|\brepurchase"),
    ("Growth", "Style & Factor", r"\bgrowth\b"),
    ("Value", "Style & Factor", r"\bvalue\b"),
    ("Momentum", "Style & Factor", r"\bmomentum\b"),
    ("Quality", "Style & Factor", r"\bquality\b"),
    ("Low Volatility", "Style & Factor", r"\blow\s+volatilit|\bmin(?:imum)?\s+vol"),
    ("ESG & Sustainable", "Style & Factor", r"\besg\b|\bsustainab|\bsocial|\bimpact\b|\bcatholic|\bbiblical|\bhalal|\bshariah"),
    ("Equal Weight", "Style & Factor", r"\bequal[- ]weight"),
    ("Small Cap", "Style & Factor", r"\bsmall[- ]?cap|\bmicro[- ]?cap|\brussell\s*2000\b|\bs&p\s*600\b"),
    ("Mid Cap", "Style & Factor", r"\bmid[- ]?cap|\bs&p\s*400\b"),
    ("Multi-Factor", "Style & Factor", r"\bmulti[- ]?factor|\bfactor\b|\bsmart\s+beta"),

    # ---- broad market ----
    ("S&P 500", "Broad Market", r"\bs&p\s*500\b|\bsp500\b|\b500\s+index\b"),
    ("Nasdaq-100", "Broad Market", r"\bnasdaq[- ]?100\b|\bqqq\b"),
    ("Dow Jones", "Broad Market", r"\bdow\s+jones\b|\bdjia\b"),
    ("Total Market", "Broad Market", r"\btotal\s+(?:stock\s+)?market\b|\bbroad\s+market\b|\bentire\s+market"),
    ("Large Cap", "Broad Market", r"\blarge[- ]?cap\b|\bmega[- ]?cap\b|\bs&p\s*100\b"),
    ("Asset Allocation", "Broad Market", r"\ballocation\b|\btarget\s+(?:date|risk)|\bbalanced\b|\bmulti[- ]asset|\bportfolio\b"),
    ("Managed Futures & Alt", "Thematic",
     r"\bmanaged\s+futures|\bhedge\s+fund|\bmerger\s+arb|\blong[/ ]short|\bmarket\s+neutral|"
     r"\btrend\s+following|\bmulti[- ]strateg|\babsolute\s+return|\balternatives?\b|\barbitrage"),
    ("Türkiye", "International", r"\bturkey\b|\bturkish\b|\bturkiye\b"),
    ("Developed ex-US", "International", r"\bkokusai\b"),
    ("Structured Outcome", "Options Income",
     r"\bautocallable|\bbarrier\b|\bweeklypay|\byieldboost|\bmanaged\s+risk|\bsos\b"),
    ("Income (Multi-Asset)", "Fixed Income",
     r"\bincome\s+(?:opportunit|fund|etf|plus)|\bmulti[- ]asset\s+income|\bdiversified\s+income|"
     r"\bhigh\s+income|\bincome\s+strateg"),
    ("Sector Rotation", "Style & Factor",
     r"\bsector\s+(?:rotation|select)|\brotation\b|\ball[- ]season|\btactical\b"),
    ("Concentrated & Active Equity", "Style & Factor",
     r"\bfocus(?:ed)?\s*\d*\b|\bbest\s+ideas|\bconviction|\bselect\s+\d+|\bibd\s*\d+|"
     r"\btop\s+\d+|\bownership\b|\bcash\s+flow\b"),
    ("Belt & Road / Thematic EM", "International", r"\bbelt\s+and\s+road|\bone\s+belt"),
    ("Currency", "Thematic",
     r"\bcurrency\b|\bdollar\s+index|\byen\b|\beuro\s+currency|\bfx\b|\bforex"),
    ("Sector Rotation", "Style & Factor", r"\bu\.?s\.?\s+sector\b|\btrusector|\bsector\s+etf"),
    ("US Equity (Broad)", "Broad Market",
     r"\bu\.?s\.?\s+equity|\bamerican?\s+equity|\bdomestic\s+equity|\bequity\s+total\s+return"),
]
COMPILED = [(theme, cat, re.compile(pat, re.I)) for theme, cat, pat in RULES]
DEFAULT_THEME, DEFAULT_CATEGORY = "Unclassified", "Thematic"


def classify_theme(name: str) -> tuple[str, str]:
    """-> (category, theme)."""
    text = name or ""
    for theme, category, pat in COMPILED:
        if pat.search(text):
            return category, theme
    return DEFAULT_CATEGORY, DEFAULT_THEME


def classify(name: str) -> str:
    """Broad category only; kept for callers that do not want the theme."""
    return classify_theme(name)[0]


# --------------------------------------------------------------------------
# Türkiye
# --------------------------------------------------------------------------
# TEFAS gives a fund type ("Hisse Senedi Şemsiye Fonu"), which is the broad
# category, but the specific mandate is only in the title. These run in the
# same priority order: what the fund holds beats the wrapper it sits in.
TR_RULES: list[tuple[str, str]] = [
    ("Altın", r"\bALTIN\b|\bALTINA\b|\bGOLD\b"),
    ("Gümüş", r"GÜMÜŞ|GUMUS|SILVER"),
    ("Kıymetli Maden", r"KIYMETLİ\s+MADEN|PLATİN|PALADYUM"),
    ("BIST 30", r"BIST\s*30|BİST\s*30"),
    ("BIST 100", r"BIST\s*100|BİST\s*100"),
    ("Katılım", r"KATILIM|KATILIM\s*30|FAİZSİZ"),
    ("Temettü", r"TEMETT"),
    ("Banka", r"\bBANKA|BANKACILIK"),
    ("Teknoloji", r"TEKNOLOJ|BİLİŞİM|YAZILIM|İLETİŞİM"),
    ("TLREF", r"TLREF"),
    ("Gayrimenkul", r"GAYRİMENKUL|GYO\b"),
    ("Enerji", r"ENERJİ|TEMİZ\s+ENERJİ|ELEKTRİK"),
    ("Sürdürülebilirlik", r"SÜRDÜRÜLEBİL"),
    ("Yabancı & Döviz", r"YABANCI|DOLAR|EURO|AMERİKAN|DÖVİZ|USD"),
    ("Sanayi", r"SINAİ|SANAYİ"),
    ("Likit & Para Piyasası", r"LİKİT|PARA\s+PİYASASI|KISA\s+VADELİ"),
    ("Borçlanma Araçları", r"BORÇLANMA|TAHVİL|BONO|KİRA\s+SERTİFİKA|EUROBOND"),
    ("Fon Sepeti", r"FON\s+SEPETİ"),
    ("Endeks", r"ENDEKS"),
    ("Hisse Senedi", r"HİSSE\s+SENEDİ"),
    ("Serbest", r"SERBEST"),
    ("Değişken", r"DEĞİŞKEN"),
]
TR_COMPILED = [(theme, re.compile(pat, re.I)) for theme, pat in TR_RULES]

# TEFAS fund type -> broad category, with "Şemsiye Fonu" trimmed off.
TR_CATEGORY = {
    "Altın Fonu": "Precious Metal",
    "Gümüş Fonu": "Precious Metal",
    "Kıymetli Madenler Şemsiye Fonu": "Precious Metal",
    "Endeks Fon": "Equity Index",
    "Hisse Senedi Yoğun": "Equity Index",
    "Hisse Senedi Fonu": "Equity Index",
    "Hisse Senedi Şemsiye Fonu": "Equity Index",
    "Yabancı Fon": "International",
    "Borçlanma Araçları Şemsiye Fonu": "Fixed Income",
    "Para Piyasası Şemsiye Fonu": "Fixed Income",
    "Serbest Şemsiye Fonu": "Serbest Fon",
    "Katılım Şemsiye Fonu": "Katılım",
    "Fon Sepeti Şemsiye Fonu": "Fon Sepeti",
    "Değişken Şemsiye Fonu": "Değişken",
    "Karma Şemsiye Fonu": "Karma",
}


def classify_tr(title: str, fund_type: str = "", is_etf: bool = False) -> tuple[str, str]:
    """-> (category, theme) for a Turkish fund."""
    category = "ETF (BYF)" if is_etf else TR_CATEGORY.get((fund_type or "").strip(), "Diğer")
    text = title or ""
    for theme, pat in TR_COMPILED:
        if pat.search(text):
            return category, theme
    return category, "Unclassified"
