// UK gazetteer + foreign-location detection. Pure data + pure functions, ZERO network.
//
// WHY THIS FILE EXISTS
// --------------------
// Reed and Adzuna do their radius search SERVER-SIDE, so the pipeline never had
// to check distance itself — it trusted the source. ATS boards (Greenhouse,
// Lever, Ashby, Workday) vouch for NOTHING: hitting a board returns the
// company's ENTIRE GLOBAL board. Palantir's Lever board hands back "Seoul,
// South Korea" and "Palo Alto, CA" in the same payload as "London, United
// Kingdom". Without the data below, a Birmingham user asking for "within 25
// miles" gets Seoul.
//
// The gazetteer is hardcoded on purpose:
//   • it's the hot path — every one of ~3,000 postings per ingest run hits it;
//   • it must work with no network, no key, no quota (postcodes.io is the
//     fallback for the long tail, not the primary);
//   • the ~120 places below cover the overwhelming majority of UK postings.
//
// Coordinates are town-centre, 3dp (~110m). We filter by a 25-MILE radius, not
// route a van — precision beyond that buys nothing.

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ResolvedPlace extends GeoPoint {
  /** Canonical place name, e.g. "Birmingham". */
  name: string;
  /** ISO-2 uppercase, e.g. "GB". */
  country: string;
  source: "gazetteer" | "postcodes.io" | "provider" | "cache";
}

/**
 * Lowercase, strip accents/punctuation, collapse whitespace.
 * "St. Albans" / "St Albans" / "ST ALBANS" must all be one key.
 * NOTE: keeps spaces, drops everything else non-alphanumeric.
 */
export function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents (NFD): "Malaga" -> "malaga"
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// UK PLACES
// ---------------------------------------------------------------------------

/** Canonical UK places → centre point. Keys are the canonical display names. */
export const UK_PLACES: Record<string, GeoPoint> = {
  // --- England: majors ---
  London: { lat: 51.507, lng: -0.128 },
  Birmingham: { lat: 52.48, lng: -1.903 },
  Manchester: { lat: 53.479, lng: -2.245 },
  Leeds: { lat: 53.801, lng: -1.549 },
  Sheffield: { lat: 53.383, lng: -1.466 },
  Bradford: { lat: 53.795, lng: -1.759 },
  Liverpool: { lat: 53.408, lng: -2.991 },
  Bristol: { lat: 51.455, lng: -2.588 },
  Coventry: { lat: 52.407, lng: -1.508 },
  Leicester: { lat: 52.637, lng: -1.139 },
  Nottingham: { lat: 52.954, lng: -1.15 },
  "Newcastle upon Tyne": { lat: 54.978, lng: -1.618 },
  Sunderland: { lat: 54.906, lng: -1.383 },
  Brighton: { lat: 50.827, lng: -0.153 },
  Hull: { lat: 53.745, lng: -0.336 },
  Plymouth: { lat: 50.376, lng: -4.143 },
  "Stoke-on-Trent": { lat: 53.003, lng: -2.18 },
  Wolverhampton: { lat: 52.586, lng: -2.129 },
  Derby: { lat: 52.922, lng: -1.477 },
  Southampton: { lat: 50.91, lng: -1.404 },
  Portsmouth: { lat: 50.805, lng: -1.087 },
  Reading: { lat: 51.454, lng: -0.978 },
  "Milton Keynes": { lat: 52.041, lng: -0.759 },
  Northampton: { lat: 52.24, lng: -0.903 },
  Luton: { lat: 51.879, lng: -0.42 },
  Norwich: { lat: 52.63, lng: 1.297 },
  Oxford: { lat: 51.752, lng: -1.258 },
  Cambridge: { lat: 52.205, lng: 0.119 },
  Ipswich: { lat: 52.059, lng: 1.155 },
  Exeter: { lat: 50.718, lng: -3.533 },
  York: { lat: 53.96, lng: -1.081 },
  Solihull: { lat: 52.412, lng: -1.778 },
  Slough: { lat: 51.511, lng: -0.591 },
  Watford: { lat: 51.656, lng: -0.398 },
  Bournemouth: { lat: 50.72, lng: -1.88 },
  Peterborough: { lat: 52.573, lng: -0.245 },
  Preston: { lat: 53.759, lng: -2.699 },
  Warrington: { lat: 53.39, lng: -2.597 },
  Telford: { lat: 52.678, lng: -2.445 },
  Basildon: { lat: 51.572, lng: 0.47 },
  Blackpool: { lat: 53.817, lng: -3.036 },
  Middlesbrough: { lat: 54.574, lng: -1.235 },
  Bolton: { lat: 53.578, lng: -2.429 },
  Stockport: { lat: 53.408, lng: -2.149 },
  Swindon: { lat: 51.56, lng: -1.782 },
  Huddersfield: { lat: 53.645, lng: -1.785 },
  Poole: { lat: 50.715, lng: -1.987 },
  Gloucester: { lat: 51.864, lng: -2.244 },
  Chelmsford: { lat: 51.736, lng: 0.469 },
  Colchester: { lat: 51.889, lng: 0.903 },
  Crawley: { lat: 51.113, lng: -0.187 },
  Basingstoke: { lat: 51.266, lng: -1.087 },
  Worthing: { lat: 50.817, lng: -0.372 },
  Doncaster: { lat: 53.523, lng: -1.133 },
  Rotherham: { lat: 53.43, lng: -1.357 },
  Rochdale: { lat: 53.614, lng: -2.156 },
  Salford: { lat: 53.483, lng: -2.293 },
  Wigan: { lat: 53.545, lng: -2.632 },
  Oldham: { lat: 53.541, lng: -2.117 },
  Bath: { lat: 51.38, lng: -2.36 },
  Cheltenham: { lat: 51.899, lng: -2.078 },
  Chester: { lat: 53.19, lng: -2.892 },
  Lincoln: { lat: 53.234, lng: -0.538 },
  Maidstone: { lat: 51.272, lng: 0.529 },
  Woking: { lat: 51.319, lng: -0.558 },
  Guildford: { lat: 51.236, lng: -0.57 },
  "St Albans": { lat: 51.755, lng: -0.336 },
  Croydon: { lat: 51.372, lng: -0.1 },
  Bromley: { lat: 51.406, lng: 0.015 },
  "Kingston upon Thames": { lat: 51.409, lng: -0.306 },
  Canterbury: { lat: 51.28, lng: 1.079 },
  Durham: { lat: 54.777, lng: -1.575 },
  Lancaster: { lat: 54.047, lng: -2.801 },
  Carlisle: { lat: 54.892, lng: -2.932 },

  // --- England: West Midlands / Marches ---
  "Sutton Coldfield": { lat: 52.563, lng: -1.824 },
  Dudley: { lat: 52.512, lng: -2.081 },
  Walsall: { lat: 52.586, lng: -1.982 },
  "West Bromwich": { lat: 52.519, lng: -1.995 },
  Redditch: { lat: 52.306, lng: -1.941 },
  Worcester: { lat: 52.192, lng: -2.22 },
  Kidderminster: { lat: 52.388, lng: -2.25 },
  Shrewsbury: { lat: 52.707, lng: -2.752 },
  Stafford: { lat: 52.807, lng: -2.117 },
  "Burton upon Trent": { lat: 52.803, lng: -1.643 },
  Tamworth: { lat: 52.634, lng: -1.691 },
  Nuneaton: { lat: 52.523, lng: -1.465 },
  Rugby: { lat: 52.37, lng: -1.265 },
  "Stratford-upon-Avon": { lat: 52.192, lng: -1.707 },

  // --- England: South / East ---
  Bedford: { lat: 52.136, lng: -0.467 },
  "Southend-on-Sea": { lat: 51.54, lng: 0.71 },
  Bracknell: { lat: 51.416, lng: -0.754 },
  "High Wycombe": { lat: 51.629, lng: -0.749 },
  Aylesbury: { lat: 51.815, lng: -0.813 },
  "Hemel Hempstead": { lat: 51.753, lng: -0.449 },
  Stevenage: { lat: 51.902, lng: -0.202 },
  Harlow: { lat: 51.772, lng: 0.102 },
  Farnborough: { lat: 51.293, lng: -0.754 },
  Newbury: { lat: 51.401, lng: -1.323 },
  Banbury: { lat: 52.061, lng: -1.339 },
  Winchester: { lat: 51.06, lng: -1.31 },
  Chichester: { lat: 50.837, lng: -0.78 },
  Eastbourne: { lat: 50.769, lng: 0.29 },
  Hastings: { lat: 50.854, lng: 0.573 },
  Salisbury: { lat: 51.069, lng: -1.794 },
  "Bury St Edmunds": { lat: 52.245, lng: 0.711 },

  // --- England: South West ---
  Truro: { lat: 50.263, lng: -5.051 },
  Torquay: { lat: 50.462, lng: -3.525 },
  Taunton: { lat: 51.015, lng: -3.106 },
  Yeovil: { lat: 50.942, lng: -2.633 },
  "Weston-super-Mare": { lat: 51.346, lng: -2.977 },

  // --- England: North ---
  Blackburn: { lat: 53.748, lng: -2.482 },
  Burnley: { lat: 53.789, lng: -2.248 },
  Barnsley: { lat: 53.554, lng: -1.479 },
  Wakefield: { lat: 53.683, lng: -1.499 },
  Halifax: { lat: 53.723, lng: -1.863 },
  Harrogate: { lat: 53.992, lng: -1.541 },
  Scarborough: { lat: 54.283, lng: -0.399 },
  Grimsby: { lat: 53.567, lng: -0.081 },
  Chesterfield: { lat: 53.235, lng: -1.421 },
  Mansfield: { lat: 53.144, lng: -1.199 },
  Loughborough: { lat: 52.771, lng: -1.202 },
  Kettering: { lat: 52.398, lng: -0.729 },
  Crewe: { lat: 53.099, lng: -2.44 },
  Macclesfield: { lat: 53.259, lng: -2.129 },
  "Stockton-on-Tees": { lat: 54.57, lng: -1.317 },
  Darlington: { lat: 54.527, lng: -1.553 },
  Hartlepool: { lat: 54.69, lng: -1.213 },
  Gateshead: { lat: 54.953, lng: -1.603 },

  // --- Scotland ---
  Glasgow: { lat: 55.864, lng: -4.252 },
  Edinburgh: { lat: 55.953, lng: -3.188 },
  Aberdeen: { lat: 57.149, lng: -2.094 },
  Dundee: { lat: 56.462, lng: -2.97 },
  Inverness: { lat: 57.478, lng: -4.224 },
  Perth: { lat: 56.396, lng: -3.437 },
  Stirling: { lat: 56.117, lng: -3.937 },
  Paisley: { lat: 55.847, lng: -4.424 },
  Livingston: { lat: 55.883, lng: -3.517 },
  "East Kilbride": { lat: 55.764, lng: -4.177 },
  Falkirk: { lat: 56.002, lng: -3.784 },
  Ayr: { lat: 55.458, lng: -4.629 },
  Kilmarnock: { lat: 55.611, lng: -4.496 },
  Dunfermline: { lat: 56.071, lng: -3.452 },
  Kirkcaldy: { lat: 56.113, lng: -3.161 },

  // --- Wales ---
  Cardiff: { lat: 51.481, lng: -3.179 },
  Swansea: { lat: 51.622, lng: -3.944 },
  Newport: { lat: 51.584, lng: -2.998 },
  Wrexham: { lat: 53.046, lng: -2.993 },
  Barry: { lat: 51.399, lng: -3.283 },
  Bridgend: { lat: 51.504, lng: -3.577 },
  "Merthyr Tydfil": { lat: 51.746, lng: -3.378 },
  Llanelli: { lat: 51.681, lng: -4.163 },
  Caerphilly: { lat: 51.578, lng: -3.218 },
  Cwmbran: { lat: 51.653, lng: -3.021 },
  Aberystwyth: { lat: 52.415, lng: -4.083 },
  // Bangor is genuinely ambiguous within the UK (Gwynedd vs County Down). Both
  // are real, both are GB, and they're 250 miles apart — but for a RADIUS filter
  // the only thing that matters is that we don't call it foreign. We list the
  // Welsh one as canonical "Bangor" (larger, university town) and the NI one
  // under its own key; aliases below route "Bangor, Co. Down" to the right one.
  Bangor: { lat: 53.228, lng: -4.129 },
  "Bangor, County Down": { lat: 54.657, lng: -5.668 },

  // --- Northern Ireland ---
  Belfast: { lat: 54.597, lng: -5.93 },
  Londonderry: { lat: 54.997, lng: -7.309 },
  Lisburn: { lat: 54.516, lng: -6.058 },
  Newry: { lat: 54.176, lng: -6.349 },
  Craigavon: { lat: 54.447, lng: -6.387 },
  Ballymena: { lat: 54.865, lng: -6.279 },
};

/**
 * Alias → canonical key in UK_PLACES. Keys here are NORMALISED (see normalise()).
 * London boroughs/districts collapse to London: a job in Shoreditch is, for a
 * 25-mile radius, in London.
 */
export const UK_ALIASES: Record<string, string> = {
  // London and its synonyms / districts
  "greater london": "London",
  "city of london": "London",
  "central london": "London",
  "north london": "London",
  "south london": "London",
  "east london": "London",
  "west london": "London",
  "canary wharf": "London",
  shoreditch: "London",
  soho: "London",
  westminster: "London",
  camden: "London",
  islington: "London",
  southwark: "London",
  hackney: "London",
  "london uk": "London",
  "london england": "London",
  "london area": "London",
  ldn: "London",

  // Other conurbations / common shorthands
  "greater manchester": "Manchester",
  "west midlands": "Birmingham",
  brum: "Birmingham",
  newcastle: "Newcastle upon Tyne",
  "newcastle upon tyne": "Newcastle upon Tyne",
  "newcastle on tyne": "Newcastle upon Tyne",
  stoke: "Stoke-on-Trent",
  "stoke on trent": "Stoke-on-Trent",
  "brighton and hove": "Brighton",
  hove: "Brighton",
  "kingston upon hull": "Hull",
  "hull city": "Hull",
  "saint albans": "St Albans",
  "st albans": "St Albans",
  derry: "Londonderry",
  "derry londonderry": "Londonderry",
  "bangor county down": "Bangor, County Down",
  "bangor co down": "Bangor, County Down",
  "bangor northern ireland": "Bangor, County Down",
  "bangor gwynedd": "Bangor",
  "bangor wales": "Bangor",
  "stratford upon avon": "Stratford-upon-Avon",
  "burton on trent": "Burton upon Trent",
  "weston super mare": "Weston-super-Mare",
  "southend on sea": "Southend-on-Sea",
  "stockton on tees": "Stockton-on-Tees",
  "milton keynes": "Milton Keynes",
  "edinburgh scotland": "Edinburgh",
  glasgow: "Glasgow",
};

/**
 * UK country-level terms. These are NOT points — "UK" is 600 miles long, so
 * geocoding it to a centroid (a field in Staffordshire) would let a nationwide
 * posting masquerade as a local one. They set is_country_only instead, and the
 * CALLER decides: a nationwide search accepts them, a 25-mile search does not
 * (unless the posting is also remote).
 */
export const UK_COUNTRY_TERMS: ReadonlySet<string> = new Set([
  "uk",
  "u k",
  "gb",
  "gbr",
  "britain",
  "great britain",
  "united kingdom",
  "england",
  "scotland",
  "wales",
  "cymru",
  "northern ireland",
  "n ireland",
  "uk wide",
  "uk remote",
  "nationwide",
  "england and wales",
  "united kingdom of great britain and northern ireland",
]);

/**
 * UK counties / regions. In a COMMA-TAIL position these behave like "United
 * Kingdom": they qualify the head as a UK place rather than being a second
 * place. "Solihull, West Midlands" is ONE place, not two.
 * (Note "west midlands" is ALSO a UK_ALIAS → Birmingham, for when it stands
 * alone. Tail-position wins, which is what we want.)
 */
export const UK_REGION_QUALIFIERS: ReadonlySet<string> = new Set([
  "greater london", "greater manchester", "west midlands", "merseyside",
  "west yorkshire", "south yorkshire", "north yorkshire", "east yorkshire",
  "tyne and wear", "county durham", "durham", "northumberland", "cumbria",
  "lancashire", "cheshire", "derbyshire", "nottinghamshire", "lincolnshire",
  "leicestershire", "rutland", "staffordshire", "shropshire", "herefordshire",
  "worcestershire", "warwickshire", "northamptonshire", "cambridgeshire",
  "norfolk", "suffolk", "essex", "hertfordshire", "bedfordshire",
  "buckinghamshire", "oxfordshire", "berkshire", "surrey", "kent",
  "east sussex", "west sussex", "hampshire", "isle of wight", "dorset",
  "wiltshire", "somerset", "devon", "cornwall", "avon", "gloucestershire",
  "bristol city", "south west england", "south east england", "east of england",
  "east midlands", "west midlands region", "north west england",
  "north east england", "yorkshire", "yorkshire and the humber", "the midlands",
  "midlands", "home counties",
  // Scotland
  "lothian", "midlothian", "west lothian", "east lothian", "fife",
  "aberdeenshire", "ayrshire", "lanarkshire", "renfrewshire", "perthshire",
  "highlands", "strathclyde", "borders",
  // Wales
  "glamorgan", "south glamorgan", "west glamorgan", "mid glamorgan", "gwynedd",
  "powys", "dyfed", "gwent", "clwyd", "south wales", "north wales",
  // Northern Ireland
  "county antrim", "co antrim", "county down", "co down", "county armagh",
  "co armagh", "county tyrone", "co tyrone", "county fermanagh",
  "co fermanagh", "county londonderry", "co londonderry",
]);

// ---------------------------------------------------------------------------
// FOREIGN DETECTION — the safety-critical half
// ---------------------------------------------------------------------------

/**
 * Non-UK countries: name/code (normalised) → ISO-2.
 *
 * ⚠️ IRELAND IS NOT THE UK. "Dublin" is a foreign city; "Belfast" is a UK one.
 * Getting this backwards is the single most likely error in this file.
 */
export const FOREIGN_COUNTRIES: Record<string, string> = {
  // Europe
  ireland: "IE", "republic of ireland": "IE", eire: "IE", ie: "IE", irl: "IE",
  france: "FR", fr: "FR", fra: "FR",
  germany: "DE", deutschland: "DE", de: "DE", deu: "DE", ger: "DE",
  spain: "ES", espana: "ES", es: "ES", esp: "ES",
  portugal: "PT", pt: "PT", prt: "PT",
  italy: "IT", italia: "IT", it: "IT", ita: "IT",
  netherlands: "NL", holland: "NL", "the netherlands": "NL", nl: "NL", nld: "NL",
  belgium: "BE", be: "BE", bel: "BE",
  luxembourg: "LU", lu: "LU", lux: "LU",
  switzerland: "CH", ch: "CH", che: "CH",
  austria: "AT", at: "AT", aut: "AT",
  poland: "PL", polska: "PL", pl: "PL", pol: "PL",
  "czech republic": "CZ", czechia: "CZ", cz: "CZ", cze: "CZ",
  slovakia: "SK", sk: "SK", svk: "SK",
  hungary: "HU", hu: "HU", hun: "HU",
  romania: "RO", ro: "RO", rou: "RO",
  bulgaria: "BG", bg: "BG", bgr: "BG",
  greece: "GR", gr: "GR", grc: "GR",
  croatia: "HR", hr: "HR", hrv: "HR",
  slovenia: "SI", si: "SI", svn: "SI",
  serbia: "RS", rs: "RS", srb: "RS",
  ukraine: "UA", ua: "UA", ukr: "UA",
  lithuania: "LT", lt: "LT", ltu: "LT",
  latvia: "LV", lv: "LV", lva: "LV",
  estonia: "EE", ee: "EE", est: "EE",
  finland: "FI", fi: "FI", fin: "FI",
  sweden: "SE", sverige: "SE", se: "SE", swe: "SE",
  norway: "NO", norge: "NO", no: "NO", nor: "NO",
  denmark: "DK", danmark: "DK", dk: "DK", dnk: "DK",
  iceland: "IS", is: "IS", isl: "IS",
  russia: "RU", ru: "RU", rus: "RU",
  turkey: "TR", turkiye: "TR", tr: "TR", tur: "TR",
  cyprus: "CY", cy: "CY", cyp: "CY",
  malta: "MT", mt: "MT", mlt: "MT",
  // Middle East / Africa
  israel: "IL", il: "IL", isr: "IL",
  "united arab emirates": "AE", uae: "AE", ae: "AE",
  "saudi arabia": "SA", sa: "SA", sau: "SA",
  qatar: "QA", qa: "QA", qat: "QA",
  egypt: "EG", eg: "EG", egy: "EG",
  "south africa": "ZA", za: "ZA", zaf: "ZA",
  kenya: "KE", ke: "KE", ken: "KE",
  nigeria: "NG", ng: "NG", nga: "NG",
  morocco: "MA", mar: "MA",
  // Asia-Pacific
  india: "IN", in: "IN", ind: "IN",
  pakistan: "PK", pk: "PK", pak: "PK",
  china: "CN", cn: "CN", chn: "CN",
  "hong kong": "HK", hk: "HK", hkg: "HK",
  taiwan: "TW", tw: "TW", twn: "TW",
  japan: "JP", jp: "JP", jpn: "JP",
  "south korea": "KR", korea: "KR", "republic of korea": "KR", kr: "KR", kor: "KR",
  singapore: "SG", sg: "SG", sgp: "SG",
  malaysia: "MY", my: "MY", mys: "MY",
  indonesia: "ID", id: "ID", idn: "ID",
  thailand: "TH", th: "TH", tha: "TH",
  vietnam: "VN", vn: "VN", vnm: "VN",
  philippines: "PH", ph: "PH", phl: "PH",
  australia: "AU", au: "AU", aus: "AU",
  "new zealand": "NZ", nz: "NZ", nzl: "NZ",
  // Americas
  "united states": "US", "united states of america": "US", usa: "US", us: "US",
  "u s": "US", "u s a": "US", america: "US",
  canada: "CA", can: "CA",
  mexico: "MX", mx: "MX", mex: "MX",
  brazil: "BR", brasil: "BR", br: "BR", bra: "BR",
  argentina: "AR", ar: "AR", arg: "AR",
  chile: "CL", cl: "CL", chl: "CL",
  colombia: "CO", co: "CO", col: "CO",
  peru: "PE", pe: "PE", per: "PE",
  uruguay: "UY", uy: "UY", ury: "UY",
  "costa rica": "CR", cr: "CR", cri: "CR",
  panama: "PA", pa: "PA", pan: "PA",
};

/**
 * Multi-country REGIONS that are unambiguously not-UK.
 *
 * ⚠️ JUDGEMENT CALL: "Europe" and "EMEA" are deliberately NOT here. Post-Brexit
 * the UK is still in Europe/EMEA, and a "Europe" posting on a London-HQ board
 * (Synthesia does exactly this) usually DOES include the UK. Calling it foreign
 * would positively DROP a real job. It resolves to no place instead — so a
 * 25-mile search won't match it, but a remote/nationwide search still can.
 */
export const FOREIGN_REGIONS: Record<string, string> = {
  americas: "US",
  "north america": "US",
  "latin america": "US",
  latam: "US",
  apac: "SG",
  "asia pacific": "SG",
  asia: "SG",
  anz: "AU",
  "middle east": "AE",
  mena: "AE",
  africa: "ZA",
};

/** US states + DC, by 2-letter code. */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy","dc",
]);

/** US states + DC, spelled out. Safe to match case-insensitively. */
export const US_STATE_NAMES: ReadonlySet<string> = new Set([
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut",
  "delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan",
  "minnesota","mississippi","missouri","montana","nebraska","nevada",
  "new hampshire","new jersey","new mexico","new york state","north carolina",
  "north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont",
  "virginia","washington state","west virginia","wisconsin","wyoming",
  "district of columbia",
]);

/** Canadian provinces + Australian states, by code. "London, ON" is Canada. */
export const OTHER_SUBDIVISION_CODES: ReadonlySet<string> = new Set([
  // Canada
  "ab","bc","mb","nb","nl","ns","nt","nu","on","pe","qc","sk","yt",
  // Australia
  "nsw","vic","qld","wa","sa","tas","act","nt",
]);

// ⚠️ "Victoria" is deliberately ABSENT (it's the Australian state, but it's also
// central London — flagging it foreign would drop real London jobs). Australian
// postings are caught by their city ("Melbourne") or the "VIC" code instead.
export const OTHER_SUBDIVISION_NAMES: Record<string, string> = {
  ontario: "CA", quebec: "CA", "british columbia": "CA", alberta: "CA",
  manitoba: "CA", saskatchewan: "CA", "nova scotia": "CA",
  "new south wales": "AU", queensland: "AU", tasmania: "AU",
  "western australia": "AU", "south australia": "AU",
};

/**
 * Major foreign cities that appear on ATS boards, keyed normalised → ISO-2.
 *
 * ⚠️ ONLY reached when NO foreign qualifier and NO UK gazetteer match was found
 * (see parse.ts ordering). A bare UK-collision name (Birmingham, Manchester,
 * Cambridge, Newcastle, Perth, Halifax, Bangor, Richmond, Windsor) must NOT be
 * listed here — the UK reading wins for a bare name, and the qualifier ("AL",
 * "MA", "NSW") is what flips it foreign.
 *
 * ⚠️ JUDGEMENT CALLS (both listed here on purpose):
 *   • "Boston"     — Boston, MA dominates ATS boards by orders of magnitude;
 *                    Boston, Lincs (pop 45k) is a rounding error. Left off, a
 *                    bare "Boston" would fall through to postcodes.io, resolve
 *                    to Lincolnshire, and quietly ADMIT US jobs.
 *   • "Washington" — same: Washington DC/State vs Washington, Tyne & Wear.
 *                    "Washington, Tyne and Wear" still resolves as UK because
 *                    the UK region qualifier is checked before this list.
 */
export const FOREIGN_CITIES: Record<string, string> = {
  // US
  "new york": "US", "new york city": "US", nyc: "US", brooklyn: "US",
  manhattan: "US", "san francisco": "US", sf: "US", "bay area": "US",
  "palo alto": "US", "mountain view": "US", "menlo park": "US", "san jose": "US",
  sunnyvale: "US", cupertino: "US", oakland: "US", "los angeles": "US",
  la: "US", "santa monica": "US", "san diego": "US", seattle: "US",
  redmond: "US", bellevue: "US", portland: "US", austin: "US", dallas: "US",
  houston: "US", "san antonio": "US", denver: "US", boulder: "US",
  chicago: "US", boston: "US", washington: "US", "washington dc": "US",
  atlanta: "US", miami: "US", orlando: "US", tampa: "US", philadelphia: "US",
  pittsburgh: "US", detroit: "US", minneapolis: "US", phoenix: "US",
  "salt lake city": "US", nashville: "US", charlotte: "US", raleigh: "US",
  "las vegas": "US", "kansas city": "US", "st louis": "US", columbus: "US",
  cincinnati: "US", cleveland: "US", indianapolis: "US", milwaukee: "US",
  baltimore: "US", gaithersburg: "US", reston: "US", arlington: "US",
  "mclean": "US", "san mateo": "US", "santa clara": "US", irvine: "US",
  // Canada
  toronto: "CA", vancouver: "CA", montreal: "CA", ottawa: "CA", calgary: "CA",
  edmonton: "CA", waterloo: "CA",
  // Ireland — NOT the UK.
  dublin: "IE", cork: "IE", galway: "IE", limerick: "IE",
  // Europe
  paris: "FR", lyon: "FR", marseille: "FR", toulouse: "FR", bordeaux: "FR",
  nice: "FR", lille: "FR",
  berlin: "DE", munich: "DE", muenchen: "DE", hamburg: "DE", frankfurt: "DE",
  cologne: "DE", koln: "DE", stuttgart: "DE", dusseldorf: "DE", dresden: "DE",
  leipzig: "DE", karlsruhe: "DE",
  madrid: "ES", barcelona: "ES", valencia: "ES", seville: "ES", malaga: "ES",
  bilbao: "ES",
  lisbon: "PT", lisboa: "PT", porto: "PT",
  rome: "IT", milan: "IT", milano: "IT", turin: "IT", naples: "IT",
  bologna: "IT", florence: "IT",
  amsterdam: "NL", rotterdam: "NL", "the hague": "NL", utrecht: "NL",
  eindhoven: "NL", delft: "NL",
  brussels: "BE", antwerp: "BE", ghent: "BE", leuven: "BE",
  zurich: "CH", geneva: "CH", basel: "CH", lausanne: "CH", lugano: "CH",
  vienna: "AT", wien: "AT", graz: "AT", salzburg: "AT",
  warsaw: "PL", krakow: "PL", wroclaw: "PL", gdansk: "PL", poznan: "PL",
  prague: "CZ", praha: "CZ", brno: "CZ",
  bratislava: "SK", budapest: "HU", bucharest: "RO", "cluj napoca": "RO",
  sofia: "BG", athens: "GR", thessaloniki: "GR", zagreb: "HR", ljubljana: "SI",
  belgrade: "RS", kyiv: "UA", kiev: "UA", lviv: "UA",
  vilnius: "LT", kaunas: "LT", riga: "LV", tallinn: "EE",
  helsinki: "FI", espoo: "FI",
  stockholm: "SE", gothenburg: "SE", malmo: "SE",
  oslo: "NO", bergen: "NO",
  copenhagen: "DK", aarhus: "DK",
  reykjavik: "IS", istanbul: "TR", ankara: "TR",
  moscow: "RU", "st petersburg": "RU",
  "luxembourg city": "LU", valletta: "MT", nicosia: "CY", limassol: "CY",
  // Middle East / Africa
  "tel aviv": "IL", jerusalem: "IL", haifa: "IL",
  dubai: "AE", "abu dhabi": "AE", doha: "QA", riyadh: "SA", cairo: "EG",
  "cape town": "ZA", johannesburg: "ZA", nairobi: "KE", lagos: "NG",
  // Asia-Pacific
  bangalore: "IN", bengaluru: "IN", mumbai: "IN", delhi: "IN",
  "new delhi": "IN", hyderabad: "IN", pune: "IN", chennai: "IN",
  gurgaon: "IN", noida: "IN",
  karachi: "PK", lahore: "PK", islamabad: "PK",
  beijing: "CN", shanghai: "CN", shenzhen: "CN", guangzhou: "CN",
  "hong kong": "HK", taipei: "TW",
  tokyo: "JP", osaka: "JP", kyoto: "JP",
  seoul: "KR", busan: "KR",
  singapore: "SG", "kuala lumpur": "MY", jakarta: "ID", bangkok: "TH",
  hanoi: "VN", "ho chi minh city": "VN", manila: "PH",
  sydney: "AU", melbourne: "AU", brisbane: "AU", adelaide: "AU", canberra: "AU",
  auckland: "NZ", wellington: "NZ",
  // Latin America
  "mexico city": "MX", guadalajara: "MX", monterrey: "MX",
  "sao paulo": "BR", "rio de janeiro": "BR", "belo horizonte": "BR",
  "buenos aires": "AR", santiago: "CL", bogota: "CO", medellin: "CO",
  lima: "PE", montevideo: "UY", "san jose costa rica": "CR",
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Normalised UK place index, built once. Includes aliases. */
const UK_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const canonical of Object.keys(UK_PLACES)) m.set(normalise(canonical), canonical);
  for (const [alias, canonical] of Object.entries(UK_ALIASES)) {
    if (UK_PLACES[canonical]) m.set(normalise(alias), canonical);
  }
  return m;
})();

/** UK gazetteer lookup. Returns null on miss — the caller then tries postcodes.io. */
export function lookupUkPlace(query: string): ResolvedPlace | null {
  const canonical = UK_INDEX.get(normalise(query));
  if (!canonical) return null;
  const pt = UK_PLACES[canonical];
  return { name: canonical, country: "GB", lat: pt.lat, lng: pt.lng, source: "gazetteer" };
}

export function isUkCountryTerm(query: string): boolean {
  return UK_COUNTRY_TERMS.has(normalise(query));
}

export function isUkRegionQualifier(query: string): boolean {
  return UK_REGION_QUALIFIERS.has(normalise(query));
}

/**
 * Is this token an EXPLICIT foreign qualifier (a country, a multi-country
 * region, or a US/CA/AU subdivision)? Returns the ISO-2 country, or null.
 *
 * ⚠️ `original` (pre-normalisation) matters. Two- and three-letter ISO codes
 * collide with ordinary English words — "in" is India, "no" is Norway, "is" is
 * Iceland, "co" is Colombia, "or" is Oregon, "at" is Austria. Matching those
 * case-insensitively would flag "Bangor, Co. Down" as Colombian and drop a real
 * Northern Irish job. So a SHORT code only counts when it was written in CAPS,
 * which is how every ATS on earth writes it: "Palo Alto, CA", "US - ... - MD",
 * "Newcastle, NSW". Long-form names ("Lithuania", "Ontario") are matched
 * case-insensitively, since they can't collide with anything.
 */
export function foreignQualifierOf(original: string): string | null {
  const raw = original.trim();
  const norm = normalise(raw);
  if (!norm) return null;

  // A UK term is never a foreign qualifier. Guards "London, UK" and the
  // "GB"/"IS"-style code collisions.
  if (UK_COUNTRY_TERMS.has(norm) || UK_REGION_QUALIFIERS.has(norm)) return null;

  const isShortCode = norm.replace(/\s/g, "").length <= 3 && /^[a-z\s]+$/.test(norm);
  if (isShortCode) {
    // Caps-only rule. "D.C." normalises to "d c" -> letters "DC" in the original.
    const letters = raw.replace(/[^A-Za-z]/g, "");
    if (letters !== letters.toUpperCase()) return null;
    const code = letters.toLowerCase();
    if (US_STATE_CODES.has(code)) return "US";
    if (OTHER_SUBDIVISION_CODES.has(code)) {
      // "WA" and "SA" are shared US/AU codes; "NT"/"ON" are CA/AU. The exact
      // country hardly matters — all that matters is NOT-GB — but prefer US for
      // the codes the US also uses.
      if (US_STATE_CODES.has(code)) return "US";
      return ["nsw", "vic", "qld", "tas", "act"].includes(code) ? "AU" : "CA";
    }
    const country = FOREIGN_COUNTRIES[code];
    if (country) return country;
    return null;
  }

  if (FOREIGN_COUNTRIES[norm]) return FOREIGN_COUNTRIES[norm];
  if (FOREIGN_REGIONS[norm]) return FOREIGN_REGIONS[norm];
  if (US_STATE_NAMES.has(norm)) return "US";
  if (OTHER_SUBDIVISION_NAMES[norm]) return OTHER_SUBDIVISION_NAMES[norm];
  return null;
}

/** A known foreign CITY (not a qualifier). Only consulted after UK lookup fails. */
export function foreignCityOf(query: string): string | null {
  return FOREIGN_CITIES[normalise(query)] ?? null;
}

/**
 * Rough UK bounding box, for provider-supplied lat/lng (SmartRecruiters ships
 * coordinates). Includes Shetland (61N) and the western tip of NI (-8.7E).
 * A point outside this box is positively foreign.
 */
export function isInUkBbox(p: GeoPoint): boolean {
  return p.lat >= 49.5 && p.lat <= 61.1 && p.lng >= -8.7 && p.lng <= 2.1;
}
