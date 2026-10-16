/* Server-side mirror of the template catalogue's VALID IDS ONLY (public/app.html's
   TEMPLATES array is the single source of truth for what each template actually looks
   like — fonts, layout, section order, style tokens — none of which the server needs to
   render anything). All the server needs, and all it does here, is the one thing the spec
   requires explicitly: "validate template IDs on the server instead of trusting arbitrary
   client input" (Task 4 §6). A client can send any string in data.tpl; this module makes
   sure only an id that actually exists in the catalogue (or a recognised legacy value) is
   ever persisted, silently normalizing anything else to a safe default rather than
   rejecting the whole save over a cosmetic field.
   IMPORTANT: if a template is ever added, renamed or removed in public/app.html's
   TEMPLATES array, this id list must be updated to match, or new templates will silently
   be saved as the default instead of the one the user picked. */
const VALID_TEMPLATE_IDS = new Set([
  'classic-pro-01', 'classic-pro-02', 'modern-pro-01', 'modern-pro-02',
  'minimal-01', 'minimal-02', 'corporate-01', 'corporate-02',
  'executive-01', 'executive-02', 'data-analyst-01', 'data-analyst-02',
  'biz-analyst-01', 'biz-analyst-02', 'dev-01', 'dev-02',
  'ml-01', 'ml-02', 'tech-01', 'tech-02',
  'finance-01', 'finance-02', 'marketing-01', 'marketing-02',
  'ops-01', 'ops-02', 'fresher-01', 'fresher-02',
  'graduate-01', 'graduate-02', 'intern-01', 'intern-02',
  'experienced-01', 'experienced-02', 'academic-01', 'academic-02',
]);
const DEFAULT_TEMPLATE_ID = 'classic-pro-01';
const LEGACY_TPL_MAP = { classic: 'classic-pro-01', clean: 'modern-pro-01' };

function resolveTemplateId(id) {
  if (typeof id === 'string' && VALID_TEMPLATE_IDS.has(id)) return id;
  if (typeof id === 'string' && LEGACY_TPL_MAP[id]) return LEGACY_TPL_MAP[id];
  return DEFAULT_TEMPLATE_ID;
}

module.exports = { VALID_TEMPLATE_IDS, DEFAULT_TEMPLATE_ID, LEGACY_TPL_MAP, resolveTemplateId };
