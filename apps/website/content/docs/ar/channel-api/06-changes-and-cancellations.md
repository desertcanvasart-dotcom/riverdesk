---
title: التعديلات والإلغاءات
summary: بيانات الضيوف، والتعديلات مع معرفة السعر أولًا، والإلغاء مع غرامته.
---

# التعديلات والإلغاءات

## بيانات الضيوف

```bash
curl -s -X PATCH "$API/v1/bookings/$REF/guests" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{ "guests": [
        { "cabin": 0, "first_name": "Emma", "last_name": "Clarke", "lead": true,
          "nationality": "GB", "date_of_birth": "1985-04-02", "passport_number": "…" } ] }'
```

يستبدل هذا الاستدعاء قائمة الضيوف. وهو مسموح حتى **الموعد النهائي لقائمة الركاب** (manifest cut-off) (٧ أيام قبل الصعود افتراضيًا).

## التعديلات: السعر أولًا، ثم التطبيق

1. **سعِّر التغيير**. أرسل `sailing_id` آخر، أو القائمة الجديدة الكاملة لـ `cabins`، أو كليهما:

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendment-quotes" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{ "sailing_id": "'$OTHER'" }'
```

تحتوي الإجابة على **عرض السعر** الجديد، و**التغييرات** (`date`، `category`، `occupancy`، `cabins`)، و**الرسوم** وفق سياسة التعديل الخاصة بالحجز، و**الفرق** في السعر.

2. **طبِّقه** مع إرسال رقم المراجعة التي تعدّلها في `If-Match`:

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendments" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  -d '{ "amendment_quote_id": "'$AMENDMENT_QUOTE'" }'
```

إذا تغيّر الحجز في هذه الأثناء، تتلقى `409 REVISION_CHANGED`: اقرأه مرة أخرى وابدأ من جديد. تُحرَّر الكبائن القديمة وتُؤخذ الجديدة في خطوة واحدة، ويزيد رقم المراجعة بمقدار واحد.

## الإلغاء

```bash
curl -s -X POST "$API/v1/bookings/$REF/cancel" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{ "reason": "Guest cancelled" }'
```

تُظهر الاستجابة **الغرامة**: النسبة من الإجمالي وفق سياسة الإلغاء التي بيع الحجز بموجبها، بحسب عدد الأيام المتبقية قبل الصعود (بتاريخ القاهرة). وتعود الكبائن إلى البيع فورًا.
