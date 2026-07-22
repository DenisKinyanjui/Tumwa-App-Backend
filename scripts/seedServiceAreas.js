// One-time seed: backfills the ServiceArea collection with the areas that
// used to be hardcoded in the mobile app (Tumwa-App IdentityVerification.tsx
// AREAS_OPTIONS), so the admin-managed /api/locations endpoint has the same
// starting list runners were seeing before.
//
// Run with: node scripts/seedServiceAreas.js
require('dotenv').config();
const mongoose = require('mongoose');
const ServiceArea = require('../models/ServiceArea');

const AREAS = [
  { name: 'CBD',                      region: 'Nairobi' },
  { name: 'Westlands',                region: 'Nairobi' },
  { name: 'Karen / Langata',          region: 'Nairobi' },
  { name: 'Kileleshwa / Kilimani',    region: 'Nairobi' },
  { name: 'South B & C',              region: 'Nairobi' },
  { name: 'Ngong Road',               region: 'Nairobi' },
  { name: 'Thika Road',               region: 'Nairobi' },
  { name: 'Kasarani',                 region: 'Nairobi' },
  { name: 'Embakasi',                 region: 'Nairobi' },
  { name: 'Ngara / Parklands',        region: 'Nairobi' },
  { name: 'Industrial Area',          region: 'Nairobi' },
  { name: 'Eastleigh',                region: 'Nairobi' },
  { name: 'Hurlingham',               region: 'Nairobi' },
  { name: 'Ruiru',                    region: 'Kiambu' },
  { name: 'Athi River',               region: 'Machakos' },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const existingCount = await ServiceArea.countDocuments();
  if (existingCount > 0) {
    console.log(`ServiceArea collection already has ${existingCount} document(s) — skipping seed`);
  } else {
    await ServiceArea.insertMany(
      AREAS.map(({ name, region }, index) => ({ name, region, sortOrder: index })),
    );
    console.log(`Seeded ${AREAS.length} service areas`);
  }

  await mongoose.connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
