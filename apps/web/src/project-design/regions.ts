import { REGION_PORTALS } from './region-portals.js';
import type { Subject } from './model.js';
const specialCities: Record<string, string> = { 深圳: '广东', 厦门: '福建', 宁波: '浙江', 青岛: '山东', 大连: '辽宁' };
export const PROVINCES = REGION_PORTALS.filter(r => !(r.name in specialCities)).map(r => r.name);
export function regionalPortal(registration: Subject['registration']) {
  if (!registration?.province) return undefined;
  const province = registration.province.replace(/省$|市$|壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/g, '');
  const city = registration.city.trim().replace(/市$/, '');
  if ((!city && Object.values(specialCities).includes(province)) || (specialCities[city] && specialCities[city] !== province)) return undefined;
  const jurisdiction = specialCities[city] === province ? city : province;
  return REGION_PORTALS.find(r => r.name === jurisdiction);
}
