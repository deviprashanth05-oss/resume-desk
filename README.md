# Resume Desk: deploy panradhu epdi

Chat-based ATS resume builder. Users resume upload pannalam, edhu language-la venumnaalum command kudukkalam, PDF or Word download pannalam.

## Folder-la enna irukku

- `public/index.html` : full app (UI). Idhu dhaan website.
- `api/ai.js` : chinna backend. Browser-ku Claude API key theriyaama, server-la irundhu Claude-ai call pannum. Usage limits-um idhula dhaan.
- `server.js` : local-a or Render / Railway maari hosts-la run panna.
- `vercel.json` : Vercel-ku 60 second timeout setting.
- `.env.example` : environment variables list.

## Step 1: API key edukkunga

1. https://console.anthropic.com poi account create pannunga.
2. Console-la monthly spend limit set pannunga. Idhu romba mukkiyam. Yaarachum abuse pannaalum, andha amount-ku mela bill aagaadhu.
3. **API Keys** section-la oru key create pannunga (`sk-ant-...`). Idha yaarukum share pannaadheenga, GitHub-la podaadheenga.
4. Pricing-a Anthropic website-la paarunga. Users perusaana bill-um perusaagum, so limits set pannunga.

## Step 2A: Vercel-la deploy (easy, free-a start pannalam)

1. Indha folder-a GitHub repo-va push pannunga (real keys-a push pannaadheenga).
2. https://vercel.com poi "Add New Project" → andha repo select pannunga.
3. **Environment Variables**-la add pannunga: `ANTHROPIC_API_KEY` = ungal key.
4. Deploy click pannunga. Konja neram-la link kedaikkum. Custom domain venum-naa Vercel Settings → Domains.

## Step 2B: Vera host (Render, Railway, VPS)

- Node 18 or above venum.
- Start command: `npm start`
- Environment variable: `ANTHROPIC_API_KEY`
- Local-a test: `ANTHROPIC_API_KEY=sk-ant-... npm start` appuram http://localhost:3000 open pannunga.

## Step 3: Bill-a protect pannunga (public-ku podum munnaadi)

| Setting | Default | Enna pannum |
|---|---|---|
| `LIMIT_PER_HOUR` | 20 | Oru visitor-ku oru hour-la max AI calls |
| `LIMIT_PER_DAY` | 1500 | Motha website-ku oru naal max AI calls |
| `ALLOWED_ORIGIN` | (empty) | Ungal domain mattum API use panna anumadhikkum |
| Upstash Redis | off | Vercel-la limits correct-a work aaga. upstash.com-la free database create panni `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` add pannunga |

Upstash illaama Vercel-la run pannina, limits ovvoru server instance-ku thani-thani-a irukkum, so strict-a irukkaadhu. Public launch-ku Upstash add pannunga.

## Step 4: Launch-ku munnaadi checklist

- **Privacy note:** Users resume text Anthropic API-ku anuppapadum. Idha ungal Privacy Policy page-la solunga. App-la already oru chinna note irukku.
- **Disclaimer:** "AI thappu pannalam, apply pannum munnaadi check pannunga" nu app-la irukku. Adhai neekkaadheenga.
- **Test pannunga:** 3-4 real resumes (PDF, Word, photo) upload panni paarunga. Tamil text irundha Word download use pannunga (PDF-la Tamil letters varaadhu).
- **Analytics** venum-naa Plausible or Google Analytics `public/index.html` `<head>`-la add pannalaam.
- **Monetize:** Ippo ellaarum free. Later paid plan venum-naa, login + payment (Razorpay/Stripe) add pannanum. Adhu separate work.

## Model maathanum-naa

`CLAUDE_MODEL` environment variable-la vera model name podunga. Default `claude-sonnet-5`.
