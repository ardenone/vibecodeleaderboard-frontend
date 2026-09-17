.PHONY: test

# No build step in this repo — `test` is the only target CI needs.
test:
	node functions/test-og-injection.js
	node tests/report-sse-contract.test.js
