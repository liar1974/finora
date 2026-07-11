# Finora

**Your personal financial assistant. All data are on your own computer.**

Finora is a personal financial assistant that brings your bank accounts,
investments, and credit reports together into one clear picture — then helps you
make sense of it. It runs on your own laptop and
keeps everything in a single file on your machine.

Finora never moves your money, never stores your bank passwords anywhere online,
and never gives financial advice. It helps you *see*, *understand*, and act on
your own numbers — every decision stays yours.

![Finora banking overview](docs/media/screenshots/banking.png)

## What Finora does for you

- **Everything in one place.** Connect your bank and brokerage and add your
  credit report, then review all your accounts, spending, and investments
  together — without handing your full financial history to a website.
- **Your data stays with you.** All of your information lives in your
  own computer. There is no Finora cloud account and no copy of your money kept
  online.
- **Know what actually needs your attention.** Finora surfaces things like
  unusual spending, high credit-card usage, idle cash, and out-of-date accounts,
  so you're not hunting for problems yourself.
- **Get insights where you already are.** Have Finora send rule-triggered
  insights to your own **Telegram** chat or a **Slack** channel — great for a
  personal heads-up or a shared household or advisor channel. Your data still
  lives on your computer; only the alerts you choose to push are sent, and you
  connect the channels with your own bot credentials.
- **Read your credit report at home.** Load a credit report you downloaded from
  AnnualCreditReport.com and review it on your own computer, without giving it to
  a third party.
- **Ask questions locally.** Finora includes a built-in local AI model option:
  pick a model in **Settings → Models**, download it once, and chat about your
  finances with no API key, running entirely on your computer. Prefer a hosted
  model? Bring your own Anthropic, OpenAI, Google, or Ollama setup in the same
  place.

## Download

Pick your system to download the latest version. The download starts
immediately — just open the file and follow the prompts to install.

| Your computer | Download |
| --- | --- |
| 🍎 **macOS** (Apple Silicon — M1/M2/M3/M4) | [Download for Mac](https://github.com/liar1974/finora/releases/latest/download/Finora-macOS-AppleSilicon.dmg) |
| 🍎 **macOS** (Intel) | [Download for Mac (Intel)](https://github.com/liar1974/finora/releases/latest/download/Finora-macOS-Intel.dmg) |
| 🪟 **Windows** | [Download for Windows](https://github.com/liar1974/finora/releases/latest/download/Finora-Windows-Setup.exe) |
| 🐧 **Linux** (Debian/Ubuntu) | [Download for Linux (.deb)](https://github.com/liar1974/finora/releases/latest/download/Finora-Linux-x86_64.deb) |

*(Download links point at the newest release. If a link doesn't work yet, the
first version may not be published — check the
[Releases page](https://github.com/liar1974/finora/releases).)*

## Getting started

Once Finora is installed, you're a few minutes away from your first overview:

1. **Open Finora.** It starts up ready to use — no account or sign-up needed.
2. **Connect your accounts.** Link your bank and brokerage through **Plaid** from
   the **Banking** and **Brokerage** screens, and add your **Credit** report as a
   PDF you download from AnnualCreditReport.com.
3. **Explore.** Browse your spending in **Banking**, see charts in
   **Dashboards**, and check **Insights** for anything that needs attention.
4. **Get notified.** In **Settings → Delivery**, connect **Telegram**
   or **Slack** so rule-triggered insights come to you.

![Settings → Delivery, connecting Telegram or Slack](docs/media/screenshots/delivery.png)

👉 **New here? Follow the [step-by-step onboarding guide](docs/onboarding.md)** —
it walks you through installing, connecting your first account, and touring
every part of the app, with screenshots.

## Take a look

Short clips of the real app, one feature each. All footage uses **made-up demo
data only**. Each clip loops automatically — click it to open the full video.

### Review your money in one place

[![Review your money locally](docs/media/finora-promo-overview.gif)](docs/media/finora-promo-overview.mp4)

### Your transactions, kept clean

[![Your transactions, kept clean](docs/media/finora-promo-imports.gif)](docs/media/finora-promo-imports.mp4)

### Charts built from your own data

[![Dashboards from your own data](docs/media/finora-promo-dashboards.gif)](docs/media/finora-promo-dashboards.mp4)

### Quiet alerts you preview first

[![Quiet rules you preview first](docs/media/finora-promo-rules.gif)](docs/media/finora-promo-rules.mp4)

### Review your credit report at home

[![On-device credit report review](docs/media/finora-promo-credit.gif)](docs/media/finora-promo-credit.mp4)

## Your privacy

- **On your computer, not in the cloud.** Your accounts, transactions, and
  reports are stored in a single file on your own machine.
- **No online Finora account.** There's nothing to sign up for and no copy of
  your data kept on Finora's servers — because there are none.
- **It never moves money.** Finora is read-only when it comes to your finances.
  It shows you information; it can't transfer funds.
- **It never gives advice or acts for you.** Finora presents your own numbers
  clearly and leaves the decisions to you. It can *draft* a document from your own
  data — a dispute letter for a duplicate charge, a fee-waiver request, or a
  negotiation script — but only for you to review and send yourself; it never
  sends anything.
- **AI runs where you choose.** Finora has no AI service of its own. Chat and
  AI-assisted insights run on the **built-in local model** (fully on your
  machine — nothing leaves), or, if you set up a cloud provider (Anthropic,
  OpenAI, Google, Ollama, or any OpenAI-compatible endpoint), Finora sends just
  that request's context to the provider *you* chose, under their terms. There is
  no Finora server in the middle either way.

## Questions or problems

Found a bug or have a question? Please
[open an issue](https://github.com/liar1974/finora/issues).

---

*Want to build Finora from source or run it yourself? See
[CONTRIBUTING.md](CONTRIBUTING.md). Finora is **source-available**, not open
source: the code is public to read and to run for your own personal,
non-commercial use, but modifying, redistributing, or using it commercially is
not permitted. See the [LICENSE](LICENSE) for the exact terms.*
