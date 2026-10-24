---
title: الأحداث والإشعارات (webhooks)
summary: إشعارات webhooks الموقَّعة، والترتيب والتكرار، وأنواع الأحداث، واللحاق بما فات من سجل الأحداث.
---

# الأحداث والإشعارات (webhooks)

كل تغيير يخصّك هو **حدث** (event). يرسل ريفرديسك كل حدث إلى نقطة استقبال الـ webhook لديك، ويمكنك أيضًا قراءة جميع الأحداث من **سجل الأحداث**.

## الإشعارات (webhooks)

تسجّل الشركة نقطة الاستقبال لديك وتعطيك **سر التوقيع** الخاص بها. يصل كل حدث كطلب `POST` يحمل:

- `X-VS-Event-Id: <uuid>`
- `X-VS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`

أجب بـ `2xx` خلال ١٠ ثوانٍ. يُعاد إرسال التسليم الفاشل مع فترات انتظار متزايدة لمدة ٢٤ ساعة. وتستطيع الشركة رؤية كل محاولة وإعادة إرسالها.

**تحقّق من كل تسليم** قبل الوثوق به:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(
  secret: string,
  rawBody: string,
  header: string,
  now = Math.floor(Date.now() / 1000),
) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false; // older than 5 minutes: reject
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

## الترتيب والتكرار

تصل الأحداث المتعلقة بمورد واحد (حجز واحد، أو حجز مؤقت واحد) **بالترتيب**: ينتظر الحدث اللاحق حتى يُسلَّم السابق. والتسليم يتم **مرة واحدة على الأقل**، لذا قد يصلك الحدث نفسه مرتين. احتفظ بأعلى قيمة `resource_version` طبّقتها لكل `resource_id`، وتجاهل أي حدث ليس أحدث منها.

## أنواع الأحداث

| الحدث                                                       | المعنى                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `availability.changed`                                      | تغيّرت الكبائن المتاحة على مرحلة وفئة. أعد قراءة الإتاحة لتلك التواريخ                            |
| `sailing.changed`                                           | أُلغيت رحلة مغادرة أو نُقل موعدها أو تغيّر ميناؤها                                                |
| `rate.changed`                                              | تغيّرت أسعار خطة تبيعها. وتحتفظ عروض الأسعار والحجوزات الحالية بأسعارها                           |
| `hold.expired`                                              | انتهت صلاحية أحد حجوزاتك المؤقتة                                                                  |
| `booking.confirmed`، `booking.amended`، `booking.cancelled` | تغيّر حجزك. اقرأه لمعرفة التفاصيل                                                                 |
| `booking.paid_unavailable`                                  | دُفع بعد انتهاء صلاحية حجزه المؤقت وكانت الكبائن قد نفدت. ستعرض الشركة كابينة أخرى أو تردّ المبلغ |
| `request.decided`                                           | صدر قرار بشأن طلبك (راجع [الطلبات والعروض](/docs/channel-api/requests-and-offers))                |
| `offer.created`                                             | قُدِّم بديل لطلبك                                                                                 |
| `payment.recorded`، `payment.overdue`                       | استُلم مبلغ، أو تأخر سداد رصيد مستحق، على حجزك                                                    |

## اللحاق بما فات: سجل الأحداث

بعد أي توقف، اقرأ السجل بدءًا من آخر مؤشر (cursor) لديك:

```bash
curl -s "$API/v1/events?limit=500" -H "$H"
curl -s "$API/v1/events?after=$NEXT_CURSOR&limit=500" -H "$H"
```

خزّن `next_cursor` بعد كل صفحة. والصفحة الفارغة تعني أنك مواكب لآخر الأحداث. لا يُعيد السجل الأحداث إلا بعد اعتمادها (commit) بالكامل، وبترتيب الاعتماد، لذا لا يتخطى المؤشر أي حدث أبدًا.
