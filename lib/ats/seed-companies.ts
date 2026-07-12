// Seed employers for the ATS registry.
//
// The registry's real growth engine is ORGANIC: every company name that appears
// in any Reed/Adzuna pull gets queued for discovery (see scripts/discover-ats.ts
// --from-postings), so over time the registry covers exactly the employers our
// users' searches actually surface. That is the compounding asset.
//
// This list exists to give it a cold start — a spread of well-known UK employers
// across sectors, deliberately NOT just tech. Greenhouse/Lever/Ashby skew heavily
// to startups and scaleups; if we only seeded those, HuntHQ would be brilliant at
// finding you a job at a fintech and useless at finding you one in supply chain,
// retail, manufacturing, healthcare or the public sector. Workday is what reaches
// those employers, so the non-tech names here matter more than the tech ones.
//
// Being on this list does NOT mean the company has a public ATS. Discovery finds
// out, and records the misses so we never re-probe them (company_ats_discovery).

export const SEED_COMPANIES: string[] = [
  // --- Banking / fintech ---
  "Monzo", "Starling Bank", "Revolut", "Wise", "GoCardless", "Checkout.com",
  "Marshmallow", "Zopa", "OakNorth", "ClearBank", "Tide", "Curve",
  "Lloyds Banking Group", "NatWest", "Barclays", "HSBC", "Santander UK",
  "Nationwide Building Society", "Schroders", "Legal & General", "Aviva", "Admiral",

  // --- Retail / consumer / grocery (supply chain, procurement, ops) ---
  "Tesco", "Sainsbury's", "Asda", "Aldi", "Lidl", "Morrisons", "Waitrose",
  "Marks and Spencer", "John Lewis Partnership", "Co-op", "Iceland Foods",
  "Boots", "Currys", "Screwfix", "Kingfisher", "B&Q", "Next", "Primark",
  "ASOS", "Boohoo", "THG", "Ocado", "Deliveroo", "Just Eat Takeaway",
  "Greggs", "Domino's Pizza Group", "Compass Group", "Unilever",
  "Reckitt", "Diageo", "Britvic", "Associated British Foods", "Kraft Heinz",
  "PepsiCo", "Nestle", "Mars", "Bakkavor", "Cranswick", "2 Sisters Food Group",

  // --- Logistics / transport / industrial ---
  "DHL", "DPD", "Royal Mail", "Evri", "XPO Logistics", "Wincanton", "GXO Logistics",
  "Kuehne + Nagel", "DSV", "Maersk", "Network Rail", "National Grid",
  "Rolls-Royce", "BAE Systems", "Babcock International", "JCB", "Dyson",
  "GKN Aerospace", "Airbus", "Siemens", "Schneider Electric", "ABB",
  "Jaguar Land Rover", "Nissan", "Toyota", "Bosch", "Honeywell", "3M",

  // --- Energy / utilities ---
  "BP", "Shell", "Centrica", "SSE", "Octopus Energy", "OVO Energy",
  "EDF Energy", "E.ON", "Severn Trent", "Thames Water", "United Utilities",

  // --- Pharma / healthcare / life sciences ---
  "AstraZeneca", "GSK", "Haleon", "Bupa", "Boots Opticians",
  "Smith & Nephew", "ConvaTec", "Oxford Nanopore", "Benevolent AI",

  // --- Professional services / consulting ---
  "Deloitte", "PwC", "KPMG", "EY", "Accenture", "Capgemini", "Capita",
  "Serco", "Mitie", "Sodexo", "Rentokil Initial", "Bunzl",

  // --- Telco / media / entertainment ---
  "BT Group", "Vodafone", "Sky", "ITV", "Channel 4", "BBC",
  "Sony Interactive Entertainment", "Rockstar Games", "Ubisoft",
  "Spotify", "Depop", "Trainline",

  // --- Tech / software / scaleups ---
  "Cloudflare", "Stripe", "Palantir", "Synthesia", "Multiverse", "Tractable",
  "Improbable", "Darktrace", "Graphcore", "Snyk", "Onfido", "Zego",
  "Hopin", "Babylon Health", "Cazoo", "Bloom & Wild", "Gousto", "Zoopla",
  "Rightmove", "Auto Trader", "Moneysupermarket", "Skyscanner", "Expedia",
  "Booking.com", "Wayve", "Arm", "Sage", "Softwire", "Thought Machine",

  // --- Property / construction / infrastructure ---
  "Balfour Beatty", "Kier Group", "Skanska", "Laing O'Rourke", "Morgan Sindall",
  "Berkeley Group", "Barratt Developments", "Taylor Wimpey", "Persimmon",

  // --- Public sector / education / charity ---
  "NHS England", "Transport for London", "Ordnance Survey",
  "University of Oxford", "University of Cambridge", "Cancer Research UK",
  "British Red Cross", "Oxfam",
];
