# contributing

thanks for helping make `multi-wallet-tracker` even faster bhai.

## quick setup

```bash
cp .env.example .env
npm install
npm test
npm run build
```

## simple rules

* never commit real API keys or real wallet secrets. keep `.env.example` using `0x0000000000000000000000000000000000000000`.
* keep all dashboard UI buttons and badges strictly monochrome (`#141418`, `#26262E`, `#FFFFFF`, `#000000`).
* run `npm test` and `npm run build` before opening a pull request.
