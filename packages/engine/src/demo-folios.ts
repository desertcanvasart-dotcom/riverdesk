import type { VsDatabase } from '@vs/db';
import type { EngineContext } from './internal';
import { checkinDepartures } from './backoffice/checkin';
import {
  departureFolios,
  postCharge,
  saveExtraItem,
  updateVesselFolio,
  type ExtraCategory,
} from './backoffice/folios';

/**
 * A sample price list and a few charges for the demo operator (Batch E1), so the Folios tab and
 * the help pages' screenshots look real. Tests do not use it.
 */
const ITEMS: [ExtraCategory, string, string, number][] = [
  ['bar', 'مياه معدنية كبيرة', 'Mineral water, large', 300],
  ['bar', 'مشروب غازي', 'Soft drink', 350],
  ['bar', 'بيرة محلية', 'Local beer', 600],
  ['bar', 'كأس نبيذ مصري', 'Glass of Egyptian wine', 900],
  ['bar', 'قهوة تركية', 'Turkish coffee', 400],
  ['minibar', 'وجبة خفيفة من الميني بار', 'Minibar snack', 500],
  ['laundry', 'قميص', 'Shirt', 400],
  ['laundry', 'سروال', 'Trousers', 500],
  ['spa', 'تدليك ٦٠ دقيقة', 'Massage, 60 minutes', 4500],
  ['excursion', 'عرض الصوت والضوء بالكرنك', 'Karnak sound and light show', 3500],
  ['excursion', 'رحلة بالمنطاد فوق الأقصر', 'Balloon flight over Luxor', 12000],
  ['gratuity', 'إكرامية الطاقم (لكل ليلة)', 'Crew gratuity (per night)', 1000],
  ['communication', 'إنترنت لاسلكي (يوم)', 'Wi-Fi (one day)', 500],
];

const CHARGES: [number, string, number][] = [
  [0, 'Mineral water, large', 4],
  [0, 'Glass of Egyptian wine', 2],
  [0, 'Massage, 60 minutes', 1],
  [1, 'Soft drink', 3],
  [1, 'Karnak sound and light show', 2],
  [1, 'Shirt', 2],
  [2, 'Local beer', 3],
  [2, 'Wi-Fi (one day)', 2],
];

export async function createDemoFolios(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  await updateVesselFolio(db, ctx, { vesselId, folioEnabled: true, folioCurrency: 'USD' });
  const ids = new Map<string, string>();
  for (const [i, [category, nameAr, nameEn, price]] of ITEMS.entries())
    ids.set(
      nameEn,
      (
        await saveExtraItem(db, ctx, {
          category,
          nameAr,
          nameEn,
          price,
          currency: 'USD',
          sortOrder: i,
        })
      ).id,
    );
  // Charges on the first departure the Check-in screen opens with.
  const leg = (await checkinDepartures(db, ctx, { days: 14 }, { vesselId: null })).departures[0];
  if (!leg) return;
  const office = { vesselId: null };
  const cabins = (await departureFolios(db, ctx, leg.legId, office)).cabins;
  for (const [n, item, quantity] of CHARGES) {
    const cabin = cabins[n];
    if (!cabin) continue;
    await postCharge(
      db,
      ctx,
      {
        legId: leg.legId,
        bookingCabinId: cabin.bookingCabinId,
        itemId: ids.get(item)!,
        quantity,
        ...(cabin.guests[0] ? { guestName: cabin.guests[0] } : {}),
      },
      office,
    );
  }
}
