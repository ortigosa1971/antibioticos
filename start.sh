#!/usr/bin/env bash
set -e
cd backend
npm ci --no-audit --no-fund
npm start
