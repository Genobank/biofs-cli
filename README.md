# BioFS — GenoBank.io CLI

> **BioNFT-gated genomic data, meet standard bioinformatics tools.**
> Stream, view, mount, and analyze consent-gated VCFs / BAMs / FASTQs with
> `bcftools`, `samtools`, `pysam`, `IGV`, and every tool you already use —
> no FUSE install, no kext, no data copy.

[![npm version](https://img.shields.io/npm/v/@genobank/biofs.svg)](https://www.npmjs.com/package/@genobank/biofs)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE)

---

## What you can do in 30 seconds

```bash
npm install -g @genobank/biofs      # once
biofs login                          # browser pops up, sign with your wallet
biofs files                          # see what's accessible to you
biofs stream <ip_id> | bcftools stats -    # live-analyze a VCF you own
```

That's it. BioNFT ownership is verified on every request; revocation is immediate;
nothing ever hits your disk unless you ask for it.

---

## Table of contents

- [Install](#install)
- [Authentication](#authentication)
- [Discover your BioIPs](#discover-your-bioips)
- [Streaming & analysis — NEW in v2.7](#streaming--analysis--new-in-v27)
- [Downloads](#downloads)
- [Mounting as a filesystem](#mounting-as-a-filesystem)
- [Uploading & tokenization](#uploading--tokenization)
- [Access control & sharing](#access-control--sharing)
- [Running research jobs (BioOS)](#running-research-jobs-bioos)
- [BioContext manifests](#biocontext-manifests)
- [Aliases — never type hex again](#aliases--never-type-hex-again)
- [BioCID format](#biocid-format)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [Development](#development)
- [License](#license)

---

## Install

**Requires:** Node.js 18+ (uses built-in `fetch`).

```bash
# Globally (recommended)
npm install -g @genobank/biofs

# Verify
biofs --version        # → 2.7.1
```

Optional but highly recommended for researchers:

```bash
# macOS
brew install bcftools samtools htslib

# Debian / Ubuntu
sudo apt-get install bcftools samtools tabix
```

The CLI works without these; they unlock `biofs pipe` and `biofs view`
filesystem-level integration.

---

## Authentication

```bash
biofs login
# Browser opens → MetaMask / Magic Link → sign "I want to proceed"
# ✅ Authenticated as: 0x5f5a60…Ed19a
```

Credentials live at `~/.biofs/credentials.json` (0600, owner-only). The
signature is an EIP-191 `personal_sign` of the string `"I want to proceed"`
— re-usable by the CLI for the next ~30 days before you need to re-sign.

```bash
biofs whoami     # show current wallet
biofs logout     # clear cached credentials (securely overwrites then deletes)
```

---

## Discover your BioIPs

```bash
biofs files                      # full table of everything you can access
biofs files --filter vcf         # only VCFs
biofs files --source story       # only Story Protocol IP Assets
biofs files --source avalanche   # only Avalanche-side biosamples
```

Each row shows the BioCID, ip_id, filename, owner, license status, and
storage backend (S3 / GCS / Story / Avalanche).

---

## Streaming & analysis — NEW in v2.7

This is what most Mac / Linux researchers will use daily. Zero setup;
pipes cleanly into the tools you already have.

### `biofs stream` — raw bytes to stdout

```bash
biofs stream 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 | bcftools stats -
biofs stream my-wes | bcftools view -H - | head
biofs stream my-bam | samtools view -c -     # count reads
biofs stream my-wes | python - <<'PY'
import pysam, sys
for v in pysam.VariantFile(sys.stdin):
    print(v.chrom, v.pos, v.ref, v.alts)
PY
```

Flags:
- `--kind variants|reads` force the htsget datatype (default: auto-detect from filename)
- `--htsget-url <url>` override the endpoint (default: `https://htsget.genobank.app`)

### `biofs pipe` — auto-pipe into the right tool

Detects the file format from the registered filename and pipes the
stream straight into `bcftools view` (VCF) or `samtools view` (BAM).
Everything after `--` is passed through to the tool.

```bash
biofs pipe my-wes -- -H                       # bcftools view -H
biofs pipe my-wes -- -r chr17                 # region filter (client-side)
biofs pipe my-wes -- -s SAMPLE01              # single sample
biofs pipe my-bam -- -b | samtools sort       # chain
```

### `biofs view` — print file content (not piped to a tool)

For small files (DTC TXT, CSV, JSON, metadata). Respects GDPR "Right to
Access" audit logging server-side.

```bash
biofs view my-dtc --lines 50
biofs view my-report.json --format pretty
```

### `biofs htsget` — low-level GA4GH htsget (debugging)

```bash
biofs htsget service-info
biofs htsget ticket variants my-wes          # raw ticket JSON
biofs htsget ticket reads my-bam
```

Endpoint: `https://htsget.genobank.app` (GA4GH v1.2 compliant).
Auth: `Authorization: Bearer <signature>` (same signature as `biofs login`).

---

## Downloads

When you want the file on disk (not streaming):

```bash
biofs download my-wes                              # to ./55052008714000.deepvariant.vcf
biofs download my-wes ~/analysis/                  # into a directory
biofs download my-wes /tmp/sample.vcf              # exact path
biofs download --force my-wes                      # overwrite existing
```

Downloads verify BioNFT ownership on every request and log access for
GDPR Article 15 (Right to Access). Large files show a progress bar; use
`--quiet` / `-q` to silence.

GDPR-compliant variant (explicit consent prompt):

```bash
biofs download-with-consent my-wes
```

---

## Mounting as a filesystem

Three methods, pick based on your platform and use case:

| Method | When to use | Requires |
|---|---|---|
| `copy`  | Simple local work on a small set of files | nothing |
| `nfs`   | Full filesystem semantics on Linux / macOS | BioNFS server + NFS client |
| `fuse`  | **Recommended** for native Unix tool access | `biofs-fuse` binary + FUSE / macFUSE |

```bash
# 1. Copy method — downloads files on demand, read/write
biofs mount /mnt/bio --method copy

# 2. NFS method — live mount via bionfs server
biofs mount /mnt/bio --method nfs --biocid biocid://v1/sequentia/IPA/0x…/0x…

# 3. FUSE method — Rust-backed driver, lowest latency, xattrs exposed
biofs mount /mnt/bio --method fuse --biocid biocid://v1/sequentia/IPA/0x…/0x…

# Once mounted, use any Unix tool
ls -la /mnt/bio/
bcftools view /mnt/bio/sample.vcf | head
igv /mnt/bio/sample.vcf
cat /mnt/bio/.status                   # FUSE-only: consent + owner info

# Unmount
biofs umount /mnt/bio
```

**FUSE installation:**

- **macOS:** `brew install --cask macfuse` (first time needs kext approval + restart) **or** `brew install --cask fuse-t` (no reboot)
- **Linux:** `sudo apt install fuse3 libfuse3-dev`
- **biofs-fuse binary:** `git clone github.com/Genobank/biofs-fuse && cd biofs-fuse && cargo build --release`

See [biofs-fuse README](https://github.com/Genobank/biofs-fuse) for full setup.

**Remote mount on a GPU agent** (for running pipelines on a separate machine):

```bash
biofs mount-remote <biosample_id> --agent <agent_wallet>
```

---

## Uploading & tokenization

Simple upload:

```bash
biofs upload ~/data/sample.vcf                          # to your BioFS S3
biofs upload ~/data/reads.fastq.gz --type fastq         # force file type
```

Upload + tokenize as BioNFT:

```bash
biofs tokenize file ~/data/sample.vcf                   # VCF → BioIP NFT
biofs tokenize biosample <biosample_serial>             # whole biosample
biofs tokenize fastqs <biosample_serial>                # just the FASTQs
```

Options:
- `--title "..."` custom NFT title (default: AI-generated from content)
- `--description "..."` custom description
- `--license {commercial,non-commercial,exclusive,public-good,gdpr-research,ai-training,clinical-use,pharma-research,family-inheritance}` — see [Dual PIL architecture](#dual-pil-architecture) below
- `--no-ai` skip AI classification
- `--quiet` no interactive prompts (for scripting)

**Dual PIL architecture** (license values for `--license`):
- **Story Protocol PIL** (permanent, `non-commercial`, `commercial`, `exclusive`, `public-good`)
- **Sequentia BioPIL** (revocable, GDPR-compliant, `gdpr-research`, `ai-training`, `clinical-use`, `pharma-research`, `family-inheritance`)

---

## Access control & sharing

```bash
# Request access to someone else's BioIP
biofs access request <ip_id> --message "needed for chr17 study"

# Grant access (as the owner, to a requester)
biofs access grant <request_id> <receiver_wallet>

# Revoke access you previously granted
biofs access revoke <request_id>

# Revoke your own biosample consent (GDPR Article 17 — Right to Erasure)
# Note: triggers off-chain S3 deletion via the BioRouter event listener.
biofs access revoke-consent <biocid>

# See who has access to what
biofs access list                   # access you've granted
biofs shares                        # full permission graph (by you + to you)

# Ad-hoc share
biofs share <biocid_or_filename> --to <receiver_wallet> --license <license_type>

# Check a specific wallet's access to a BioCID
biofs access check <biocid> --wallet 0x…
```

---

## Running research jobs (BioOS)

Natural-language research workflows against your BioIPs:

```bash
biofs job pipelines                                    # list available pipelines
biofs job create "Annotate VCF with rare coding variants" sample.vcf \
    --pipeline vcf_annotation
biofs job status <job_id> --watch                      # live progress
biofs job results <job_id>                             # download result URLs
biofs job list --status running                        # your job queue
```

Run results are themselves tokenizable as derivative BioNFTs — the
ClaraJobNFT contract links each job output back to the source BioIP so
you get auditable lineage.

Quick annotation wrapper:

```bash
biofs annotate my-wes                                  # OpenCRAVAT with default annotators
biofs annotate my-wes --annotators clinvar,cosmic      # pick specific ones
```

**Agent health** — check if your GPU compute agent is ready:

```bash
biofs agent-health
```

---

## BioContext manifests

EIP-712-signed `.bionft` manifests let you bundle multiple BioIPs into
a single signed context for research group sharing, clinical trials,
or consortium data-use agreements.

```bash
biofs context create --out consortium.bionft \
    --include <biocid1> --include <biocid2>

biofs context publish consortium.bionft                # pin to IPFS + Sequentia
biofs context verify consortium.bionft                 # check signatures + revocations
biofs context revoke consortium.bionft                 # propagate revocation
```

---

## Aliases — never type hex again

Local shortcuts stored at `~/.biofs/aliases.json`:

```bash
biofs alias my-wes 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
biofs alias my-bam 0x9a3E6aEb78363C0b8E240Cc19803d9fe626381C4
biofs alias --list

biofs stream my-wes | bcftools stats -                 # works everywhere
biofs pipe   my-wes -- -r chr17
biofs view   my-wes
biofs download my-wes /tmp/

biofs alias --remove my-wes
```

Aliases only resolve on non-hex, non-BioCID inputs — real `ip_id` values
(`0x…`) and `biocid://` URLs always pass through untouched, so aliases
can never shadow real identifiers.

---

## BioCID format

BioCID is the universal genomic-file identifier used across GenoBank:

```
biocid://v1/<chain>/IPA/<collection_address>/<token_id>[/<filename>]
```

Examples:

```
biocid://v1/sequentia/IPA/0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401/0xCCe14315…
biocid://v1/story/IPA/0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401/42/sample.bam
biocid://v1/aeneid/IPA/0x…/99/reads.fastq.gz
```

- **`<chain>`** — `sequentia` (primary, GDPR-revocable) or `story` / `aeneid` (Story Protocol mainnet / testnet)
- **`IPA`** — literal, marks this as an Intellectual-Property-Asset reference
- **`<collection_address>`** — the SPG/ERC-721 collection contract
- **`<token_id>`** — the NFT token id (matches the `ip_id` for on-chain lookups)
- **`<filename>`** — optional; disambiguates multi-file BioNFTs

Every `biofs` command accepts an `ip_id` (`0x…`), a full BioCID URL,
or a local alias.

---

## Configuration

Files under `~/.biofs/`:

| Path | Contents | Mode |
|---|---|---|
| `credentials.json` | Signed auth token | `0600` (owner-only) |
| `aliases.json` | Your local ip_id shortcuts | `0644` |
| `config.json` | User preferences | `0644` |
| `cache/` | Per-request metadata cache | |
| `logs/` | Operation logs | |

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `BIOFS_HTSGET_URL` | `https://htsget.genobank.app` | Override htsget endpoint |
| `BIOFS_API_URL` | `https://bioip.genobank.app` | Override BioIP API endpoint |
| `BIOFS_SIGNATURE` | (from `credentials.json`) | Supply signature directly (CI/Docker) |
| `BIOFS_ALIASES` | `~/.biofs/aliases.json` | Override aliases file path |
| `DEBUG` | — | `DEBUG=1` enables verbose logging |
| `NO_COLOR` | — | `NO_COLOR=1` disables ANSI colors |

---

## Troubleshooting

### `ENOENT: no such file or directory, open '~/.biofs/credentials.json'`

You're not logged in. Run `biofs login`.

### `Signature rejected` / `Expected 65 bytes, got 4`

Your cached signature expired. `biofs logout && biofs login`.

### `htsget NotFound: no BioIP with id …`

The ip_id doesn't match anything your wallet can access. Check:

```bash
biofs files | grep <first 10 chars of ip_id>
biofs access list                    # requests pending approval?
```

### `htsget 401 Unauthorized` / `403 Forbidden`

Consent for that BioIP has been revoked, or your access license expired.
Check with the owner or run `biofs access request <ip_id>` again.

### `bcftools: htsget:// Protocol not supported`

Homebrew's default `htslib` ships without htsget compiled in. **Use
`biofs stream … | bcftools …` instead** — same effect, the CLI does the
ticket dance for you and pipes raw bytes in.

### Mount fails: `mount_macfuse: the file system is not available`

macFUSE kernel extension not loaded. Either:
- **One-time approval + reboot:** `sudo kmutil load -p /Library/Filesystems/macfuse.fs/Contents/Extensions/14/macfuse.kext`, then System Settings → Privacy & Security → "Allow Benjamin Fleischer" → restart.
- **No reboot (recommended):** `brew install --cask fuse-t` — drop-in replacement.

### Cloudflare `error code: 1010` on direct `curl`

Cloudflare blocks unknown User-Agents. The CLI sends `biofs/2.7.x
(+https://genobank.io)` automatically. If you're rolling your own script,
set a real User-Agent:

```bash
curl -A 'mytool/1.0' -H "Authorization: Bearer $SIG" https://htsget.genobank.app/…
```

### `biofs` runs but shows an older version

Global installs can shadow each other. Check:

```bash
which -a biofs                      # all matches on PATH
biofs --version                     # what's actually running
npm uninstall -g @genobank/biofs    # remove
npm install -g @genobank/biofs@latest
```

### Get a full diagnostic report

```bash
biofs report > biofs-diagnostic.txt
```

Sends nothing over the network. Includes Node version, install path, auth
status, endpoint reachability, mount tool availability, and version drift
info. Attach to any support email.

---

## Security model

- **Authentication**: EIP-191 `personal_sign` of `"I want to proceed"`. No passwords, no private keys ever leave your device.
- **Credentials on disk**: `~/.biofs/credentials.json` is `0600` (owner read/write only). Signatures are never logged or displayed.
- **Re-verification**: every `stream`, `pipe`, `download`, `mount`, `view` request is gated by a fresh Bearer-auth check against the BioNFT registry on every call — revocation takes effect immediately.
- **Bearer token in URL?** Only when unavoidable (e.g., signed S3/GCS presigned URLs). Those URLs expire in 1 hour.
- **Cloudflare TLS** terminates at the edge using the `*.genobank.app` wildcard cert (Google Trust Services).
- **GDPR**: Sequentia BioPIL supports Article 17 (Right to Erasure) via `biofs access revoke-consent` — triggers server-side S3 deletion. Story Protocol PIL licenses are **permanent** by design; don't use them for personally-identifiable data.
- **Auto-expiry**: cached credentials rotate every ~30 days.
- **Secure deletion**: `biofs logout` overwrites credentials before unlinking.

---

## Development

```bash
git clone git@github.com:Genobank/biofs-cli.git
cd biofs-cli
npm install
npm run build                       # tsc → dist/
npm run dev -- stream my-wes        # run TypeScript directly
npm test                            # jest
npm link                            # global `biofs` → this checkout
```

Architecture:

```
src/
├── index.ts              # commander entry + command registration
├── commands/             # one file per top-level command
│   ├── stream.ts         # htsget stream → stdout
│   ├── pipe.ts           # stream → bcftools/samtools view
│   ├── alias.ts          # local shortcuts
│   ├── htsget.ts         # low-level GA4GH endpoints
│   ├── mount.ts          # {copy|nfs|fuse} dispatcher
│   └── …
├── lib/
│   ├── api/client.ts     # GenoBankAPIClient (singleton)
│   ├── auth/             # login + credentials
│   ├── htsget/client.ts  # ticket fetcher
│   ├── aliases/store.ts  # ~/.biofs/aliases.json
│   ├── biofiles/         # resolver + downloader
│   ├── context/          # .bionft manifest
│   └── …
└── types/                # shared type definitions
```

Pull requests welcome. Code of conduct in `CONTRIBUTING.md`.

---

## License

**AGPL-3.0-or-later** © GenoBank.io

If you deploy a modified version of BioFS as a service, you must make
your source available under the same license. See [`LICENSE`](LICENSE)
for the full text.

---

## Support

- **Web**: <https://genobank.app/biofs>
- **Docs**: <https://genobank.app/static/Genobank_API_Educational_Guide.html>
- **GitHub**: <https://github.com/Genobank/biofs-cli>
- **Security**: [security@genobank.io](mailto:security@genobank.io)
- **General**: [support@genobank.io](mailto:support@genobank.io)
