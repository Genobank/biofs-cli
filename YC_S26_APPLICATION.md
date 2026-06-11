# YC S26 Application — GenoBank.io / Web3Kit
# Copy-paste into the form. Each answer fits YC's character limits.

---

## Company name
GenoBank.io, Inc.

## Company URL
https://genobank.io/web3kit

## Describe what your company does in 50 characters or less.

Own your DNA data. Delete it anytime. Ask AI about it.

(54 — if too long, use: "DNA kit + private AI you control." = 34)

## What is your company going to make?

We sell a $499 DNA sequencing kit. You spit in a tube, mail it to our lab, and get back your whole-exome results plus a private AI that runs on your laptop — not our servers. You can ask it anything about your genome without your data ever leaving your machine.

The key difference from 23andMe or Nucleus: you can delete everything, permanently, at any time. We built a system where burning a token makes your encrypted files unreadable. It's not a promise, it's cryptography — we physically cannot access your data.

We've been selling the underlying infrastructure (sequencing, consent management, encrypted storage) to labs and research groups since 2021. The $499 kit is the consumer version of that same stack, shipping for the first time in May 2026.

## Where do you live now, and where would the company be based after YC?

Palo Alto, CA. Delaware C-Corp. Staying in the Bay Area.

---

## FOUNDERS

## 1-minute video script (speak naturally, don't memorize)

"Hi, I'm Daniel. In 2017 my son was diagnosed with a rare genetic condition. The lab that sequenced him wouldn't give me his data — I had to threaten them with HIPAA fines to get it. Two US patents later, we've been selling the infrastructure to labs since 2021, processed 20,000+ biosamples. Now 23andMe is bankrupt and 15 million people's DNA is being auctioned off. We have a $499 kit ready to ship next month that gives people actual ownership — not a privacy policy, but a cryptographic key they control. That's what we're bringing to YC."

## Who writes code, or does other technical work on your product?

I write the smart contracts, the CLI (published on npm as @genobank/biofs, about 25K lines of TypeScript), and the token economics. A small team of engineers — paid in equity and small cash — built the streaming server and the filesystem driver. All core IP was written by me.

## How long have the founders known one another and how did you meet?

[Fill in truthfully — if solo founder, just say: "Solo founder. I've been building this full-time since 2018."]

## Please tell us about an interesting project, preferably outside of class or work, that two or more of you created together.

[If solo, answer with a personal project.]

In 2018 I wrote a paper introducing the term "BioNFT" — a revocable consent token for genomic data. It got rejected from a blockchain conference because a reviewer said "DNA cannot be non-fungible because all DNA is the same." It's now cited by IEEE's Blockchain-in-Healthcare working group and led to my first patent grant.

## Please tell us in one or two sentences about something impressive that each founder has built or achieved.

I hold two granted US patents on revocable genomic consent tokens (11,915,808 and 11,984,203). I built and deployed a custom blockchain that processes the same transactions as Story Protocol at 97% lower cost, and a streaming server that processes a whole-exome sequencing file in under 2 minutes on GPU.

## Please tell us about the time you most successfully hacked some (non-computer) system to your advantage.

There was no legal framework for individuals to own their genomic data. Labs owned it by default — you'd pay for sequencing and they'd keep the files. GDPR gave people the right to delete data, but no mechanism to actually enforce it on a biobank.

I found the gap: nothing in existing law said a person *couldn't* tokenize a biosample as a digital asset. So I invented BioNFTs — a blockchain token that acts as a revocable ownership deed for genomic files. If you hold the token, you control access. If you burn it, the encrypted files become unreadable. No institution can override this.

I filed two US patents on it, got both granted, and used them to sign lab partnerships where the patient — not the lab — holds the key. We now have 150+ labs operating under this framework. I didn't change the law. I just built a technical layer that made the existing law (GDPR Article 17, HIPAA Right of Access) actually enforceable for the first time.

---

## PROGRESS

## How far along are you?

We've been generating B2B revenue since 2021 — labs and research groups pay us for sequencing infrastructure, encrypted storage, and consent management. We've processed 20,000+ biosamples and have 150+ partnerships.

The consumer kit (Web3Kit) is new. It ships in May 2026. No consumer customers yet — this is the first time we're packaging our B2B infrastructure into something a regular person can buy.

Why launch the consumer kit now? Three things converged recently: (1) local AI models got good enough to interpret genomic data on a laptop (Llama 3.1, 2024), (2) a consumer trust crisis that makes people care about DNA ownership (23andMe bankruptcy, March 2025), and (3) cheap enough NFC hardware wallets to put in a $499 box (Tangem, 2024). The infrastructure was ready. The market wasn't. Now it is.

## How long have each of you been working on this? How much of that has been full-time?

Full-time since 2018.

## When will you have a prototype or beta?

First 100 units ship the week of May 25, 2026. The prototype is assembled and working end-to-end. International edition (Edition 02) ships Q3 2026.

## How many active users or customers do you have? How many are paying? Who is paying you the most?

Zero paying consumer customers — the kit hasn't shipped yet.

On the B2B side: [Fill in exact number] paying customers since 2021. [Fill in number active in last 90 days]. Largest customer pays [fill in]/month for [what they use].

7,000+ wallets have used our system to store genomic data through our flow over the years. These are not paying consumer subscribers.

## Revenue over the last several months.

[Fill in real numbers — monthly, not cumulative. If it's been lumpy project-based contract work, say that. Example:]

Most of our B2B revenue is project-based contract work, not MRR. Typical months range from $[X] to $[X]. Total revenue over the last 12 months: $[X].

We are not trying to dress up contract work as SaaS metrics. The consumer kit is where recurring revenue starts.

## Anything else about revenue or growth rate?

B2B revenue has kept us alive but never scaled — it's contract work, not a growth business. We kept doing it because it funded the infrastructure we needed for the consumer product.

The consumer kit is the growth bet. We don't have conversion data yet because we haven't launched. What we do have: the 23andMe bankruptcy drove [fill in if you have it: X visitors / X email signups / X inbound inquiries] to our site in the last 3 months.

## If you applied before, what changed?

First time applying.

## Prior accelerators or programs?

Techstars Web3, 2024 — Entrepreneur-in-Residence. $20K non-dilutive support + network access. Not in any active program now.

Republic crowd-raise, 2023 — $650K from ~340 small angels via SAFE at $12M cap. No board seats.

---

## IDEA

## Why did you pick this idea? Do you have domain expertise? How do you know people need what you're making?

In 2017 my son was diagnosed with a rare genetic condition. The lab refused to give me his raw sequencing files. I filed HIPAA complaints for 11 days to get my own son's DNA data. That's why I started this company.

Domain expertise: two granted US patents on this exact problem, have been running CLIA lab partnerships since 2017, author of the paper that introduced the term BioNFT.

How I know people want it: labs have been paying for the infrastructure since 2021. And since 23andMe went bankrupt in March 2025, "how do I get my DNA data out" is the most-asked question in every genetics forum online.

## What's new about what you're making? What substitutes do people resort to because it doesn't exist yet?

Two things no one else does:

First, you can actually delete your data. Everywhere else — 23andMe, Ancestry, Nucleus — "delete my data" means they promise to delete it. We use cryptographic revocation: you destroy a token, your encrypted files become unreadable. We cannot override this.

Second, the AI runs on your machine. Nucleus has a cloud AI. 23andMe had a cloud AI. "We won't look at your data" is a policy. "The AI runs offline on your laptop" is physics.

What people do today: either trust 23andMe (bankrupt, data being sold), pay Nucleus $399 (cloud-only, VC-backed, same trust problem), or download raw files and run bioinformatics tools by hand (hard, ~5,000 hobbyists do this). We're making that last option easy.

## Who are your competitors?

Nucleus Genomics — $14M from Founders Fund, better marketing than us, cloud-only AI, no data revocation.

23andMe's eventual buyer — whoever wins the estate auction gets 15M genomes but inherits a massive trust deficit.

The DIY crowd — people who order cheap sequencing from Dante Labs and run their own analysis. We're productizing what they already do.

What we understand that they don't: the data-ownership claim is marketing unless you back it with cryptographic revocation AND deletable storage AND legal compliance. You need all three. We've built all three layers. Competitors have zero or one.

## How do or will you make money? How much could you make?

Three lines: the kit at $499 (one-time, ~38% margin), an optional $9/month cloud add-on for mobile access, and enterprise licensing of our infrastructure to labs and AI companies that need consent-clean genomic training data.

The enterprise line is where the real scale is. AI companies training biological foundation models need consented, license-clear genomic datasets. We've been providing that since 2021 on a small scale. Every consumer kit we sell grows that dataset.

## How do users find your product?

So far, everything organic: Hacker News posts about our open-source CLI, my Twitter following in the genomics/Web3 space, press mentions, and the massive inbound from the 23andMe bankruptcy news cycle.

We have never run a paid ad. YC's funding would let us test paid acquisition for the first time — Reddit genomics communities, targeted ads to rare-disease parent groups, YouTube science channels.

---

## EQUITY

## Have you formed ANY legal entity yet?
Yes.

## Legal entities.
GenoBank.io, Inc. — Delaware C-Corp, Aug 2017.
GenoBank Mexico S.A. de C.V. — Mexican subsidiary, Mar 2020.

## Equity breakdown.
[Fill in your real cap table. Don't invent numbers.]

## Have you taken any investment yet?
$650K total — Republic crowd-raise (2023), SAFE at $12M post-money cap, ~340 small-check angels, no board seats. No institutional VCs.

## How much do you spend per month?
[Fill in real number. If it's ~$3-5K because you take no salary, say that plainly.]

## How much money does your company have in the bank now?
Close to zero. B2B revenue and the Republic raise have been spent on patents, infrastructure, and lab partnerships. I'm bridging current operations on personal savings.

## How long is your runway?
[Fill in honestly.] YC's $500K would give us ~18-24 months to ship the kit, test paid acquisition, and close enterprise contracts.

## Anything else we should know?
Two granted US patents owned by the company. HIPAA BAAs in place with our lab partner. The infrastructure has been serving B2B customers in production since 2021 — we're packaging what already works, not building from scratch.

---

## OTHERS

## Other ideas you considered applying with?

DNA-based wallet recovery — if you lose your crypto seed phrase, re-spit in a tube and we restore your custody. Already patented (US 11,984,203). Could be standalone for any crypto wallet.

Air-gapped clinical AI for hospitals — same local-AI stack as our consumer kit, but rack-mounted for hospital systems that can't send patient data to OpenAI. Three hospital systems have asked us about this unprompted.

## Something surprising or amusing one of you has discovered?

The easiest way to re-identify someone from "anonymized" DNA data is through their Y-chromosome markers — they share these with about 38 male relatives, most of whom are findable on public genealogy databases. Basically, if your genome is in any database, you're one GEDmatch query away from being identified by name. No encryption fixes this. The only real answer is: don't put the genome in a database you don't control. That's our entire product thesis in one sentence.

---

## CURIOUS

## What convinced you to apply to Y Combinator?

23andMe went bankrupt and 15 million people's DNA is being sold. We've been building the infrastructure for this since 2017 and have been revenue-generating from labs since 2021. Local AI models finally got good enough in 2024-2025 to make "private genomic AI" a real product. The timing is now.

Nobody at YC told me to apply. Applying cold.

## How did you hear about Y Combinator?

Paul Graham essays, 2008. MBA program assigned reading. Been following since.

---

## CHECKLIST BEFORE SUBMIT

- [ ] Record 1-min video (unlisted YouTube), paste URL
- [ ] Fill in co-founder details (or confirm solo)
- [ ] Fill in equity table with real percentages
- [ ] Fill in revenue numbers (monthly, last 6 months)
- [ ] Fill in customer count and largest customer
- [ ] Fill in monthly burn
- [ ] Fill in runway months
- [ ] Fill in any concrete consumer signal (site visitors, email signups, DMs)
- [ ] Submit before 8pm PT
