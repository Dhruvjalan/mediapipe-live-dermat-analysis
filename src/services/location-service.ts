/**
 * Location Service — Detects user's geographic location using the browser
 * Geolocation API and reverse geocodes to city/country using OpenStreetMap
 * Nominatim (free, no API key required).
 */

export interface UserLocation {
  latitude: number;
  longitude: number;
  city: string;
  state: string;
  country: string;
  displayName: string;
  detectedAt: number;
}

// Cache so we don't re-request every page navigation
let cachedLocation: UserLocation | null = null;
let detecting = false;
let detectPromise: Promise<UserLocation | null> | null = null;

/**
 * Get the cached location if available.
 */
export function getCachedLocation(): UserLocation | null {
  return cachedLocation;
}

/**
 * Detect the user's location using the browser Geolocation API
 * and reverse geocode via OpenStreetMap Nominatim.
 * Results are cached for the session.
 */
export async function detectLocation(): Promise<UserLocation | null> {
  // Return cached if fresh (< 30 min old)
  if (cachedLocation && Date.now() - cachedLocation.detectedAt < 30 * 60 * 1000) {
    return cachedLocation;
  }

  // Deduplicate concurrent calls
  if (detecting && detectPromise) {
    return detectPromise;
  }

  detecting = true;
  detectPromise = _doDetect();

  try {
    const result = await detectPromise;
    return result;
  } finally {
    detecting = false;
    detectPromise = null;
  }
}

async function _doDetect(): Promise<UserLocation | null> {
  try {
    // Step 1: Get GPS coordinates from browser
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5 * 60 * 1000, // Accept cached position up to 5 min
      });
    });

    const { latitude, longitude } = position.coords;

    // Step 2: Reverse geocode using OpenStreetMap Nominatim (free, no key)
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=12&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        'Accept-Language': 'en',
        'User-Agent': 'AyurGenX-HealthScan/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status}`);
    }

    const data = await response.json();
    const address = data.address || {};

    const city = address.city || address.town || address.village || address.municipality || address.county || 'Unknown';

    const state = address.state || address.region || '';
    const country = address.country || '';

    const displayParts = [city];
    if (state && state !== city) displayParts.push(state);
    if (country) displayParts.push(country);

    cachedLocation = {
      latitude,
      longitude,
      city,
      state,
      country,
      displayName: displayParts.join(', '),
      detectedAt: Date.now(),
    };

    console.log(
      `📍 Location detected: ${cachedLocation.displayName} (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`
    );
    return cachedLocation;
  } catch (err: any) {
    console.warn('📍 Location detection failed:', err.message || err);

    // Fallback: Try IP-based geolocation (no permission needed)
    try {
      return await _ipFallback();
    } catch {
      return null;
    }
  }
}

/**
 * Fallback: IP-based geolocation using ip-api.com (free, no key)
 */
async function _ipFallback(): Promise<UserLocation | null> {
  try {
    const res = await fetch('http://ip-api.com/json/?fields=lat,lon,city,regionName,country');
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.city) return null;

    const displayParts = [data.city];
    if (data.regionName && data.regionName !== data.city) displayParts.push(data.regionName);
    if (data.country) displayParts.push(data.country);

    cachedLocation = {
      latitude: data.lat || 0,
      longitude: data.lon || 0,
      city: data.city,
      state: data.regionName || '',
      country: data.country || '',
      displayName: displayParts.join(', '),
      detectedAt: Date.now(),
    };

    console.log(`📍 Location (IP fallback): ${cachedLocation.displayName}`);
    return cachedLocation;
  } catch {
    return null;
  }
}
