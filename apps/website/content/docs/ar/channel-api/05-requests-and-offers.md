---
title: الطلبات والعروض
summary: العقود التي تعمل عند الطلب — إرسال الطلب، والقرار، والعروض البديلة.
---

# الطلبات والعروض

إذا كان عقدك **عند الطلب** (تُظهر الإتاحة `status: "on_request"`)، فأنت تطلب وشركة الرحلات تقرر. ولا تُؤخذ أي كبائن حتى تقبل.

## إرسال طلب

```bash
curl -s -X POST "$API/v1/requests" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{ "quote_id": "'$QUOTE'", "channel_ref": "NC-REQ-1",
        "guests": [{ "cabin": 0, "first_name": "Ana", "last_name": "Lopez", "lead": true }] }'
```

يعود الحجز بالقيمة `status: "requested"` ومعه `request_expires_at`، وهو الموعد النهائي المحدد في عقدك (٦ ساعات افتراضيًا، إضافةً إلى مهلة سماح قصيرة).

## القرار

تتلقى الحدث `request.decided` ومعه `data.decision`:

| القرار           | المعنى                           |
| ---------------- | -------------------------------- |
| `accepted`       | تم تأكيد الحجز                   |
| `declined`       | غير ممكن. السبب مذكور في الحجز   |
| `timed_out`      | لم يُردّ عليه في الوقت المحدد    |
| `offer_accepted` | قبلتَ بديلًا                     |
| `offer_expired`  | لم يُقبَل البديل في الوقت المحدد |

## العروض البديلة

قد تعرض الشركة إبحارًا آخر بدلًا من المطلوب. فتتلقى `offer.created` ومعه `offer_id` و`sailing_id` و`expires_at` (٤٨ ساعة افتراضيًا). ويُظهر الحجز العرض المفتوح مع سعره. لقبوله:

```bash
curl -s -X POST "$API/v1/offers/$OFFER/accept" -H "$H" -H "Idempotency-Key: $(uuidgen)"
```

إذا لم تفعل شيئًا، تنتهي صلاحية العرض.
