# Sky data

| File | What | Source | Terms |
|---|---|---|---|
| `stars.bin` | 9,096 stars to magnitude 8: J2000 position, V magnitude, B−V colour. Little-endian int16 ×4 per star (RA×90°, Dec×300°, V×1000, B−V×1000), brightest first | Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren 1991), `bsc5.dat` from tdc-www.harvard.edu/catalogs/bsc5.html | public domain |
| `milkyway.jpg` | the Milky Way's diffuse light without the stars, equatorial (ICRF) equirectangular, RA 0h at centre increasing left | NASA/Goddard Space Flight Center Scientific Visualization Studio, *Deep Star Maps 2020* (svs.gsfc.nasa.gov/4851), `milkyway_2020_4k.exr` downscaled to 2048×1024. Gaia DR2: ESA/Gaia/DPAC | free to use with credit |
| `earth-day.jpg` | Earth's surface, October | NASA Earth Observatory, *Blue Marble Next Generation* (Reto Stöckli), `world.topo.bathy.200410` downscaled to 4096×2048 | free to use with credit |
| `earth-night.jpg` | city lights | NASA Earth Observatory, *Black Marble 2016* (Miguel Román et al.), downscaled to 4096×2048, greyscale | free to use with credit |
| `earth-clouds.jpg` | a cloud layer | NASA Earth Observatory / Visible Earth, `cloud_combined_2048` | free to use with credit |
| `iss.json` | fallback orbital elements for the ISS (CelesTrak OMM JSON), used when the live fetch is off or fails | CelesTrak, NORAD 25544 | free |

The page itself computes the rest from the clock: Greenwich sidereal time (Earth's rotation), the Sun and Moon
(low-precision formulae from the *Astronomical Almanac*, good to about 0.01° and 0.3°), precession of the
catalogue from J2000 to today, and the station's position (the elements propagated with J2 nodal and apsidal
drift and the catalogue's decay term, a simplification of SGP4 that stays close for days around the elements'
epoch; with fresh elements the ground below is the ground the ISS is over).
