.PHONY: test smoke-production

# No build step in this repo — `test` is the only target CI needs.
test:
	node functions/test-og-injection.js
	node tests/report-sse-contract.test.js
	node tests/production-smoke.test.mjs
	node functions/test-api.js

# Post-deployment check against the live production site/API. Override
# SMOKE_SITE_URL, SMOKE_API_URL, and SMOKE_USERNAME for another environment.
smoke-production:
	node scripts/production-smoke.mjs
