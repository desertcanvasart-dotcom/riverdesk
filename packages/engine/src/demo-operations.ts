import type { VsDatabase } from '@vs/db';
import type { EngineContext } from './internal';
import { getOperationsSettings, updatePortGuide, updateVesselDay } from './backoffice/operations';

/**
 * Sample on-board settings for the demo operator (Batch D3): the vessel's day and the port guide,
 * so the daily programme and the pre-departure sheet look real. For looking around locally and
 * for the help pages' screenshots; tests do not use it.
 */
const GUIDE: Record<
  string,
  { berthAr?: string; berthEn?: string; visitsAr: string; visitsEn: string }
> = {
  LXR: {
    berthAr: 'كورنيش النيل، أمام فندق ونتر بالاس',
    berthEn: 'Corniche El Nil, opposite the Winter Palace hotel',
    visitsAr: 'معبدا الكرنك والأقصر؛ وفي الضفة الغربية وادي الملوك ومعبد حتشبسوت',
    visitsEn:
      'Karnak and Luxor temples; on the West Bank, the Valley of the Kings and Hatshepsut’s temple',
  },
  ESN: { visitsAr: 'عبور هويس إسنا', visitsEn: 'Passing the Esna lock' },
  EDF: { visitsAr: 'معبد حورس في إدفو', visitsEn: 'The Temple of Horus at Edfu' },
  KOM: {
    visitsAr: 'معبد كوم أمبو ومتحف التماسيح',
    visitsEn: 'Kom Ombo temple and the Crocodile Museum',
  },
  ASW: {
    berthAr: 'كورنيش أسوان، مرسى البواخر جنوب الكورنيش',
    berthEn: 'Aswan Corniche, the cruise berths south of the Corniche',
    visitsAr: 'السد العالي ومعبد فيلة، ونزهة بالفلوكة حول جزيرة إلفنتين',
    visitsEn: 'The High Dam and Philae temple, and a felucca ride around Elephantine Island',
  },
};

export async function createDemoOperations(db: VsDatabase, ctx: EngineContext, vesselId: string) {
  const decks =
    (await getOperationsSettings(db, ctx)).vessels.find((v) => v.id === vesselId)?.decks ?? [];
  await updateVesselDay(db, ctx, {
    vesselId,
    // D4: one muster station per deck, and tables of four.
    musterStations: Object.fromEntries(
      decks.map((deck, i) => [
        deck,
        `${['A', 'B', 'C', 'D'][i % 4]} — ${['aft lounge', 'forward lounge', 'sun deck bar', 'reception'][i % 4]}`,
      ]),
    ),
    tableSize: 4,
    boardingTime: '12:00',
    breakfastTime: '07:00',
    lunchTime: '13:00',
    teaTime: '17:00',
    dinnerTime: '19:30',
    luggageTime: '06:30',
    checkoutTime: '08:00',
    programmeNoteAr:
      'حفلة الجلابية في الليلة الأخيرة. يُرجى ارتداء ملابس محتشمة عند زيارة المعابد.',
    programmeNoteEn: 'Galabeya party on the last night. Please dress modestly for temple visits.',
  });
  for (const port of (await getOperationsSettings(db, ctx)).ports) {
    const guide = GUIDE[port.code];
    if (guide) await updatePortGuide(db, ctx, { portId: port.id, ...guide });
  }
}
