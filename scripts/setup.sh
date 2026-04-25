#!/usr/bin/env bash
set -euo pipefail

cd frontend && npm install
cd ../backend && npm install
cd ..

echo "Scaffold dependencies installed for frontend + backend."
