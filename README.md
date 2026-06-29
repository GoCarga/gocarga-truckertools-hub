# GoCarga TruckerTools Hub

Standalone Render service for TruckerTools shipper links.

## Endpoints

GET /health

GET /track?shipperLink=<FULL_TRUCKERTOOLS_LINK>

POST /track

```json
{
  "shipperLink": "https://dashboard.loadtracking.truckertools.com/#/app/loadtrack-details-map?uniqueDispatchId=..."
}
```

## Render settings

Language: Node

Build Command: npm install

Start Command: npm start

Root Directory: blank

Dockerfile Path: blank

## Optional environment variables

NODE_VERSION=20

TRACKER_TIMEOUT_MS=45000

GOCARGA_TRACKING_API_KEY=optional
