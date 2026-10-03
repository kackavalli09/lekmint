# Deliberately do not import the SDK's install/publish targets.
SHELL := /bin/bash
.PHONY: x86 check
check:
	npm run check
	npm audit
x86: check
	npm run build
	start-cli s9pk pack --arch=x86_64 -o lek-mint-lab_x86_64.s9pk
	start-cli s9pk inspect lek-mint-lab_x86_64.s9pk manifest
	sha256sum lek-mint-lab_x86_64.s9pk