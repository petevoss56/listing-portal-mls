// Distances and address lookup.

export function miles(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function boxAround(lat, lon, r) {
  const dLat = r / 69.0, dLon = r / (69.0 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

// Free US Census geocoder (public, no key). Used only when the subject is not already in our MLS copy.
export async function geocode(address, fetchImpl) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(address);
  try {
    const res = await (fetchImpl || fetch)(url);
    if (!res.ok) return null;
    const j = await res.json();
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (!m) return null;
    const c = m.addressComponents || {};
    return { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress, state: c.state || null, zip: c.zip || null, city: c.city || null };
  } catch (e) { return null; }
}
