/**
 * The buyer's industry, from the organization that published the opportunity.
 *
 * "Industry" on a finding means who is buying (a school district, a city, a
 * hospital), not which search found it. Worked out from the buyer's name, its
 * parent organization and the source, with the words that decided it, and
 * always labelled as inferred.
 *
 * Import-free: runs in Node, in n8n and in the browser bundle.
 */

export const SECTORS = [
  { id: "k12", label: "K-12 education", pack: "k12", re: /\b(school (district|board|division)|district school board|board of education|conseil scolaire|commission scolaire|school unit|unified school|independent school district|isd\b|usd\b|public schools|catholic schools?|elementary|secondary school|high school|academy)\b/i },
  { id: "higher-ed", label: "Higher education", pack: "any", re: /\b(university|universit[ée]|college|coll[èe]ge|c[ée]gep|polytechnic|institute of technology|community college|school of medicine)\b/i },
  { id: "health", label: "Healthcare", pack: "any", re: /\b(health (authority|services|region|centre|center|network|system)|hospital|h[ôo]pital|medical cent(re|er)|clinic|public health|healthcare|health care|long[- ]term care|nursing home|shared health|sant[ée])\b/i },
  { id: "nonprofit", label: "Nonprofit / public-benefit", pack: "nonprofit", re: /\b(public library|library board|library|libraries|biblioth[èe]que|housing (corporation|finance|authority|agency|trust|partnership)|housing and finance|habitat for humanity|community foundation|association|society|foundation|charity|charitable|ymca|ywca|united way|non-?profit|not-for-profit|council for|human resource council|federation\b(?! of municipalities)|institute\b(?! of technology)|club|league)\b/i },
  { id: "indigenous", label: "Indigenous government", pack: "any", re: /\b(first nations?|band council|m[ée]tis|inuit|tribal|tribe|nation government|indigenous services)\b/i },
  { id: "municipal", label: "Municipal / local government", pack: "any", re: /\b(city of|town of|village of|township|municipality|municipal|county of|county\b|district of|regional district|region of|regional municipality|borough|ville de|city council|parish|federation of municipalities|association of municipalities)\b/i },
  { id: "transit", label: "Transportation and transit", pack: "any", re: /\b(transit|transportation authority|airport|port authority|harbour|harbor|railway|metrolinx|translink|toronto transit|bc transit|turnpike|toll)\b/i },
  { id: "utilities", label: "Utilities and energy", pack: "any", re: /\b(hydro|power|energy|electric|utilit(y|ies)|water (authority|board|district|commission)|sewer|gas company|nuclear)\b/i },
  { id: "defence", label: "Defence and security", pack: "any", re: /\b(national defence|defen[cs]e|army|navy|naval|air force|marine corps|coast guard|socom|military|dnd\b|rcmp|police|sheriff|corrections?|correctional|border services)\b/i },
  { id: "crown", label: "Crown corporation / public agency", pack: "any", re: /\b(crown corporation|corporation|commission|authority|agency|board\b|bureau|securities commission|insurance corporation|lottery|liquor)\b/i },
  { id: "federal-ca", label: "Federal government (Canada)", pack: "any", re: /\b(government of canada|public works and government services|pspc|shared services canada|canada revenue|parks canada|health canada|transport canada|statistics canada|employment and social development|fisheries and oceans|agriculture and agri-food|environment and climate change canada|global affairs|foreign affairs|natural resources canada|innovation, science|immigration, refugees|crown-indigenous|department of justice|national research council|canadian heritage|library and archives|veterans affairs canada|women and gender equality|public safety canada|\bcanada\b)\b/i },
  { id: "provincial", label: "Provincial / state government", pack: "any", re: /\b(province of|government of (alberta|british columbia|manitoba|new brunswick|newfoundland|nova scotia|ontario|prince edward island|quebec|saskatchewan|yukon|nunavut|northwest territories)|ministry of|minist[èe]re|state of|department of (?!defense)[a-z ]+ \(state\)|alberta|ontario|british columbia|saskatchewan|manitoba|nova scotia|new brunswick|newfoundland|qu[ée]bec|yukon|nunavut)\b/i },
  { id: "federal-us", label: "Federal government (US)", pack: "any", re: /\b(department of|dept of|u\.s\.|united states|federal|veterans affairs|general services administration|gsa\b|nasa|fda\b|epa\b|usda|dhs\b|hhs\b|doe\b|office of acq)\b/i },
];

export const SECTOR_LABELS = Object.fromEntries(SECTORS.map((s) => [s.id, s.label]));

/**
 * Classify a buyer. `source` is the channel id: SAM.gov buyers are US federal
 * unless their name says otherwise; CanadaBuys buyers default to Canadian federal.
 */
export function classifySector({ buyer, buyerType, source } = {}) {
  const text = `${buyer ?? ""} | ${buyerType ?? ""}`;
  if (!buyer && !buyerType) return null;
  for (const s of SECTORS) {
    const m = text.match(s.re);
    if (m) {
      // A US federal defence buyer is defence; a US agency with an office code is still federal.
      if (s.id === "crown" && /us\.federal\.sam/.test(source ?? "")) continue;
      // "Department of …" on CanadaBuys is a Canadian department, not a US one.
      if (s.id === "federal-us" && /canadabuys|\.ca\.|^ca\./.test(source ?? "")) return { id: "federal-ca", label: SECTOR_LABELS["federal-ca"], basis: `Canadian source; organization name contains "${m[0].trim()}"`, inferred: true };
      return { id: s.id, label: s.label, basis: `organization name contains "${m[0].trim()}"`, inferred: true };
    }
  }
  if (/us\.federal\.sam/.test(source ?? "")) return { id: "federal-us", label: SECTOR_LABELS["federal-us"], basis: "published on SAM.gov (US federal)", inferred: true };
  if (/ca\.federal\.canadabuys/.test(source ?? "")) return { id: "federal-ca", label: SECTOR_LABELS["federal-ca"], basis: "published on CanadaBuys by a federal buyer", inferred: true };
  return { id: "other", label: "Other / unclassified", basis: "buyer name did not match a sector", inferred: true };
}

export default { SECTORS, SECTOR_LABELS, classifySector };
