// Seed employers for the ATS registry.
//
// The registry's real growth engine is ORGANIC: every company name that appears
// in any Reed/Adzuna pull gets queued for discovery (see scripts/discover-ats.ts
// --from-postings), so over time the registry covers exactly the employers our
// users' searches actually surface. That is the compounding asset.
//
// This list exists to give it a cold start.
//
// 🔴🔴 WHAT THIS LIST IS FOR, AND WHY IT IS SHAPED LIKE THIS.
//
// The first version of this list was "well-known UK employers", and the corpus it
// produced was measured on 2026-07-14:
//
//     London 828 · Bristol 99 · Manchester 61 · Cardiff 41 · Edinburgh 34
//     Leeds 21 · BIRMINGHAM 7 · Sheffield 5 · Glasgow 6
//     Liverpool, Nottingham, Leicester, Coventry, Newcastle, Derby, Stoke: ZERO
//
// 43% of first-party supply was in ONE city, and a "Supply Chain Analyst /
// Birmingham" search returned NOTHING. That is not a bug in the pipeline — every
// verifier was green. It is the supply being shaped like the seed list, and the
// seed list being shaped like a tech-press rich list. A job search that only works
// if you live in London is not the best job search in the UK.
//
// So the organising principle here is NOT "big company". It is:
//
//   1. WHERE IS ITS HEAD OFFICE? A company head-officed in Atherstone, Bradford,
//      Northampton or Stoke posts its analyst, buyer, finance and ops jobs THERE.
//      London-HQ'd employers, however large, deepen the hole we are digging out of.
//   2. WHAT FUNCTION DOES IT HIRE? Manufacturing, logistics/3PL, food production,
//      retail head office, utilities, housebuilding and care employ the supply
//      chain analysts, buyers, planners, QAs and engineers our users search for.
//      Another London fintech adds a fourth copy of the same backend role.
//
// Greenhouse / Lever / Ashby are startup-and-scaleup ATSs and structurally cannot
// reach these employers. WORKDAY and SMARTRECRUITERS are the rungs that do — which
// is also why --probe-only is the wrong flag for this list: much of the enterprise
// supply is only reachable by the careers-page crawl.
//
// Being on this list does NOT mean the company has a public ATS. Discovery finds
// out, and records the misses so we never re-probe them (company_ats_discovery).
// A miss is the expected case and costs nothing; a name we never tried costs us a
// whole city. So the list errs towards INCLUDING a plausible employer.

export const SEED_COMPANIES: string[] = [
  // ===========================================================================
  // MANUFACTURING & ENGINEERING — the Midlands and the North
  // The single biggest hole. These are the employers behind every "Production
  // Planner / Quality Engineer / Buyer / Maintenance Engineer" search outside the
  // M25, and almost none of them were in the registry.
  // ===========================================================================

  // Automotive (West Midlands, North West, Merseyside)
  "Jaguar Land Rover", "Bentley Motors", "Aston Martin Lagonda", "McLaren Automotive",
  "Lotus Cars", "Nissan", "Toyota", "Vauxhall", "Stellantis", "Ford Motor Company",
  "BMW Group", "Honda UK", "Caterpillar", "Cummins", "Perkins Engines", "JCB",
  "Unipart", "GKN Automotive", "GKN Aerospace", "Dennis Eagle", "Alexander Dennis",
  "Wrightbus", "Ricardo", "Horiba MIRA", "Bosch", "ZF", "Denso",

  // Aerospace, rail, defence (Derby, Bristol, Preston, Barrow, Newton Aycliffe)
  "Rolls-Royce", "BAE Systems", "Airbus", "Leonardo", "Thales UK", "MBDA",
  "QinetiQ", "Babcock International", "Ultra Electronics", "Chemring Group",
  "Meggitt", "Safran", "Collins Aerospace", "Raytheon UK", "Spirit AeroSystems",
  "Alstom", "Hitachi Rail", "Siemens Mobility", "Wabtec", "Talgo", "Porterbrook",

  // Industrials, engineering, materials
  "Siemens", "Schneider Electric", "ABB", "Honeywell", "3M", "Emerson",
  "Weir Group", "IMI plc", "Spirax Group", "Renishaw", "Halma", "Rotork",
  "Bodycote", "Morgan Advanced Materials", "Smiths Group", "Senior plc",
  "TT Electronics", "Oxford Instruments", "Edwards Vacuum", "Vesuvius",
  "Johnson Matthey", "Croda International", "Victrex", "Synthomer", "Elementis",
  "Ineos", "Sabic UK", "Essar Oil UK", "Tata Steel", "British Steel",
  "Sheffield Forgemasters", "Liberty Steel", "Alcoa", "Norsk Hydro",

  // Building products, cement, aggregates (Leicestershire, Yorkshire, Derbyshire)
  "Ibstock", "Forterra", "Marshalls", "Breedon Group", "Aggregate Industries",
  "Tarmac", "Hanson UK", "Cemex UK", "Saint-Gobain UK", "Pilkington",
  "Wienerberger", "Travis Perkins", "SIG plc", "Grafton Group", "Kingspan",
  "Baxi", "Ideal Heating", "Glen Dimplex", "Vent-Axia", "Polypipe", "Genuit Group",

  // ===========================================================================
  // FOOD & DRINK PRODUCTION — Midlands, North, East Anglia, Wales
  // The UK's biggest manufacturing sector by headcount, and the single richest
  // source of supply chain / procurement / planning / QA roles outside London.
  // ===========================================================================
  "Bakkavor", "Cranswick", "2 Sisters Food Group", "Greencore", "Samworth Brothers",
  "Hilton Foods", "ABP Food Group", "Pilgrim's UK", "Moy Park", "Avara Foods",
  "Noble Foods", "Faccenda Foods", "Kepak", "Dunbia", "Karro Food Group",
  "Arla Foods", "Muller UK", "Saputo Dairy UK", "First Milk", "Yeo Valley",
  "Warburtons", "Hovis", "Premier Foods", "Kerry Group", "Ornua",
  "Weetabix", "Jacobs Douwe Egberts", "Tate & Lyle", "McCain Foods",
  "Nomad Foods", "Birds Eye", "Bernard Matthews", "Princes Group",
  "Mondelez International", "Ferrero", "Haribo", "Swizzels Matlow", "Burton's Biscuits",
  "Nestle", "Mars", "PepsiCo", "Kraft Heinz", "Unilever", "Reckitt",
  "Coca-Cola Europacific Partners", "Britvic", "AG Barr", "Suntory Beverage & Food",
  "Diageo", "Heineken UK", "Molson Coors", "Carlsberg Marston's Brewing Company",
  "Bacardi", "Pernod Ricard", "Cargill", "ADM", "Roquette",
  "Associated British Foods", "AB Agri", "Hain Daniels", "Bidfood", "Brakes",

  // ===========================================================================
  // LOGISTICS, 3PL, PORTS & TRANSPORT
  // Warehouses and distribution centres are, by definition, not in Zone 1.
  // ===========================================================================
  "DHL", "DPD", "Royal Mail", "Evri", "XPO Logistics", "GXO Logistics", "Wincanton",
  "Kuehne + Nagel", "DSV", "DB Schenker", "CEVA Logistics", "Yusen Logistics",
  "Rhenus Logistics", "Culina Group", "Great Bear", "Eddie Stobart",
  "Menzies Distribution", "Bibby Distribution", "Clipper Logistics", "Unipart Logistics",
  "Maersk", "DP World", "Peel Ports", "Associated British Ports", "Forth Ports",
  "Stena Line", "P&O Ferries", "Freightliner", "Gist", "Booker Group",
  "FedEx", "UPS", "Network Rail", "FirstGroup", "Stagecoach", "Go-Ahead Group",
  "National Express", "Arriva", "Northern Trains", "Avanti West Coast",
  "Great Western Railway", "LNER", "ScotRail", "Transport for Greater Manchester",
  "Transport for London", "Manchester Airports Group", "Heathrow Airport",
  "Birmingham Airport", "easyJet", "Jet2", "TUI Group", "British Airways",

  // ===========================================================================
  // RETAIL, GROCERY & HOSPITALITY HEAD OFFICES
  // Deliberately keyed to WHERE THE HEAD OFFICE IS: Asda/Morrisons (Leeds,
  // Bradford), Aldi (Atherstone), Co-op (Manchester), Iceland (Deeside),
  // B&M/Home Bargains (Liverpool), Dunelm (Leicester), Halfords (Redditch),
  // Travis Perkins & Howdens (Northampton), Bet365 (Stoke), Frasers (Shirebrook).
  // ===========================================================================
  "Tesco", "Sainsbury's", "Asda", "Morrisons", "Aldi", "Lidl", "Waitrose",
  "Co-op", "Iceland Foods", "Booths", "Marks and Spencer", "John Lewis Partnership",
  "B&M European Value Retail", "Home Bargains", "Poundland", "The Range",
  "Boots", "Superdrug", "Savers", "Holland & Barrett", "The Body Shop",
  "Currys", "Screwfix", "Toolstation", "Kingfisher", "B&Q", "Wickes",
  "Halfords", "Pets at Home", "Dunelm", "Howden Joinery", "DFS", "ScS",
  "Bensons for Beds", "Next", "Primark", "JD Sports", "Frasers Group",
  "Matalan", "N Brown Group", "Boohoo", "ASOS", "THG", "Ocado", "Card Factory",
  "The Works", "WHSmith", "Waterstones", "Clarks", "Dr Martens", "Joules",
  "Seasalt Cornwall", "FatFace", "White Stuff", "Sports Direct", "Shoe Zone",
  "Greggs", "Compass Group", "Sodexo", "Aramark", "SSP Group",
  "Mitchells & Butlers", "Greene King", "Whitbread", "JD Wetherspoon",
  "Marston's", "Stonegate Group", "Domino's Pizza Group", "Costa Coffee",
  "McDonald's", "KFC UK", "Nando's", "Pret A Manger", "Deliveroo", "Just Eat Takeaway",
  "Bet365", "Entain", "Flutter Entertainment", "Sky Betting & Gaming", "Rank Group",

  // ===========================================================================
  // UTILITIES, WATER, ENERGY NETWORKS & NUCLEAR
  // Regional by law — a water company's jobs are in its region and nowhere else.
  // ===========================================================================
  "Severn Trent", "United Utilities", "Thames Water", "Anglian Water",
  "Yorkshire Water", "Northumbrian Water", "Southern Water", "Wessex Water",
  "South West Water", "Pennon Group", "Scottish Water", "Affinity Water",
  "Welsh Water", "South Staffs Water",
  "National Grid", "UK Power Networks", "Northern Powergrid", "Electricity North West",
  "SP Energy Networks", "Cadent Gas", "Northern Gas Networks", "SGN",
  "Centrica", "British Gas", "SSE", "EDF Energy", "E.ON", "Octopus Energy",
  "OVO Energy", "ScottishPower", "Drax Group", "Sellafield Ltd",
  "Nuclear Waste Services", "Urenco", "EnergySys", "RWE", "Orsted", "Vestas",
  "BP", "Shell", "Wood Group", "Petrofac", "Subsea 7", "TechnipFMC", "Aker Solutions",

  // ===========================================================================
  // CONSTRUCTION, HOUSEBUILDING & INFRASTRUCTURE
  // Site-based by definition; head offices are in York, Newcastle, Flintshire.
  // ===========================================================================
  "Barratt Developments", "Taylor Wimpey", "Persimmon", "Bellway", "Redrow",
  "Vistry Group", "Crest Nicholson", "Miller Homes", "Keepmoat Homes",
  "Avant Homes", "Cala Homes", "Bloor Homes", "Berkeley Group",
  "Balfour Beatty", "Kier Group", "Morgan Sindall", "Galliford Try", "Costain",
  "Skanska", "Laing O'Rourke", "Sir Robert McAlpine", "Wates Group",
  "Willmott Dixon", "Mace Group", "ISG", "BAM Nuttall", "VolkerWessels UK",
  "J Murphy & Sons", "Amey", "Vinci", "Bouygues UK",

  // ===========================================================================
  // FINANCIAL SERVICES OUTSIDE LONDON
  // Building societies and insurers are the biggest white-collar employers in
  // Bradford, Coventry, Swindon, Leeds, Newcastle, Edinburgh and Cardiff.
  // ===========================================================================
  "Lloyds Banking Group", "NatWest", "Barclays", "HSBC", "Santander UK",
  "Nationwide Building Society", "Yorkshire Building Society", "Skipton Building Society",
  "Leeds Building Society", "Coventry Building Society", "Principality Building Society",
  "Virgin Money", "TSB Bank", "Metro Bank", "Shawbrook Bank", "Paragon Banking Group",
  "Aldermore", "Close Brothers", "Together Money", "Handelsbanken",
  "Admiral Group", "Direct Line Group", "Hastings Direct", "esure", "Ageas UK",
  "LV=", "NFU Mutual", "Royal London", "Phoenix Group", "Standard Life", "abrdn",
  "Baillie Gifford", "Scottish Widows", "Aegon UK", "Zurich Insurance", "AXA UK",
  "Allianz UK", "RSA Insurance", "Aviva", "Legal & General", "Schroders",
  "Markerstudy", "Sabre Insurance", "Simply Business", "Atom Bank",

  // Fintech / banking-tech (kept — but no longer the centre of gravity)
  "Monzo", "Starling Bank", "Revolut", "Wise", "GoCardless", "Checkout.com",
  "Marshmallow", "Zopa", "OakNorth", "ClearBank", "Tide", "Curve", "Thought Machine",

  // ===========================================================================
  // PHARMA, LIFE SCIENCES & PRIVATE HEALTHCARE / CARE
  // Macclesfield, Cambridge, Sandwich, Billingham, Ware — and care homes, which
  // are the largest private employer in many northern towns.
  // ===========================================================================
  "AstraZeneca", "GSK", "Haleon", "Pfizer", "MSD UK", "Novartis", "Bayer",
  "Eli Lilly", "Johnson & Johnson", "Roche", "Sanofi", "Takeda", "Ipsen",
  "Indivior", "Alliance Pharma", "Hikma Pharmaceuticals", "Accord Healthcare",
  "Recipharm", "Catalent", "Lonza", "Fujifilm Diosynth Biotechnologies",
  "Thermo Fisher Scientific", "Abcam", "Illumina", "Agilent Technologies",
  "Sartorius", "Waters Corporation", "Charles River Laboratories", "Labcorp",
  "IQVIA", "ICON plc", "Parexel", "Smith & Nephew", "ConvaTec",
  "Oxford Nanopore Technologies", "Bupa", "Spire Healthcare", "Nuffield Health",
  "Circle Health Group", "Ramsay Health Care UK", "HCA Healthcare UK",
  "Practice Plus Group", "Care UK", "Barchester Healthcare", "HC-One",
  "Anchor Hanover", "Sanctuary Group", "Mears Group",

  // ===========================================================================
  // PROFESSIONAL SERVICES, OUTSOURCING & FACILITIES
  // Big regional service-centre employers (Capita, Serco, Mitie, Teleperformance).
  // ===========================================================================
  "Deloitte", "PwC", "KPMG", "EY", "Accenture", "Capgemini", "Cognizant", "Infosys",
  "Capita", "Serco", "Mitie", "Rentokil Initial", "Bunzl", "OCS Group",
  "Teleperformance", "Concentrix", "Webhelp", "Sitel", "Ventrica",
  "Grant Thornton", "BDO", "RSM UK", "Mazars", "Arup", "Atkins", "Jacobs",
  "WSP", "Mott MacDonald", "Turner & Townsend", "Ricardo Energy & Environment",

  // ===========================================================================
  // TELCO, MEDIA & ENTERTAINMENT
  // ===========================================================================
  "BT Group", "EE", "Vodafone", "Virgin Media O2", "Three UK", "Sky", "ITV",
  "Channel 4", "BBC", "Warner Bros. Discovery", "Sony Interactive Entertainment",
  "Rockstar Games", "Ubisoft", "Codemasters", "Team17", "Sumo Group",
  "Spotify", "Depop", "Trainline",

  // ===========================================================================
  // TECH / SOFTWARE / SCALEUPS (kept — but this is the sector we were ALREADY
  // good at, so nothing new is added here)
  // ===========================================================================
  "Cloudflare", "Stripe", "Palantir", "Synthesia", "Multiverse", "Tractable",
  "Improbable", "Darktrace", "Graphcore", "Snyk", "Onfido", "Zego",
  "Gousto", "Zoopla", "Rightmove", "Auto Trader", "Moneysupermarket",
  "Skyscanner", "Expedia", "Booking.com", "Wayve", "Arm", "Sage", "Softwire",
  "Bloom & Wild", "Trustpilot", "Featurespace", "Matillion", "The Access Group",
  "Advanced", "Civica", "IRIS Software Group", "Kainos", "Version 1",

  // ===========================================================================
  // UNIVERSITIES
  // A large civic university is often the biggest single employer in its city, and
  // hires far beyond academia — finance, HR, estates, procurement, IT, marketing.
  // ===========================================================================
  "University of Manchester", "University of Birmingham", "University of Leeds",
  "University of Nottingham", "University of Sheffield", "University of Liverpool",
  "University of Bristol", "University of Warwick", "Loughborough University",
  "Coventry University", "Durham University", "Newcastle University",
  "University of York", "University of Southampton", "University of Exeter",
  "University of Leicester", "Nottingham Trent University",
  "Manchester Metropolitan University", "Sheffield Hallam University",
  "University of Edinburgh", "University of Glasgow", "Cardiff University",
  "Queen's University Belfast", "University of Oxford", "University of Cambridge",
  "Open University",

  // ===========================================================================
  // PUBLIC SECTOR, NHS & LOCAL GOVERNMENT
  // Low expected hit rate (most run NHS Jobs / TRAC / Civil Service Jobs rather
  // than a public ATS) — but a miss is cached and free, and a hit is a whole city
  // of supply. Worth every probe.
  // ===========================================================================
  "NHS England", "Guy's and St Thomas' NHS Foundation Trust",
  "Manchester University NHS Foundation Trust",
  "University Hospitals Birmingham NHS Foundation Trust",
  "Leeds Teaching Hospitals NHS Trust", "Barts Health NHS Trust",
  "Birmingham City Council", "Manchester City Council", "Leeds City Council",
  "Birmingham Children's Trust", "Environment Agency", "Met Office",
  "Ordnance Survey", "UK Health Security Agency", "Nuclear Decommissioning Authority",
  "Homes England", "National Highways", "DVLA", "Crown Commercial Service",

  // ===========================================================================
  // CHARITIES & NON-PROFITS
  // Head offices are in Swindon, Sandy, Poole, Ilford — not London — and they hire
  // fundraising, retail, finance and programme staff nationwide.
  // ===========================================================================
  "Cancer Research UK", "British Red Cross", "Oxfam", "Save the Children",
  "NSPCC", "Age UK", "RSPCA", "RNLI", "National Trust", "English Heritage",
  "Historic England", "RSPB", "The Salvation Army", "Barnardo's", "Marie Curie",
  "Macmillan Cancer Support", "Alzheimer's Society", "Mind", "Scope", "Shelter",
  "Sue Ryder", "WWF-UK", "Guide Dogs", "Blue Cross", "Dogs Trust",
  "Battersea Dogs & Cats Home", "Citizens Advice", "Trussell Trust",
  "The Prince's Trust", "Wellcome Trust", "Nesta", "Turn2us",
];
