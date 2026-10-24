---
title: التعديلات والإلغاءات
summary: حدّث بيانات الضيوف، وراجع تكلفة تعديل الحجز قبل تطبيقه، وألغِ الحجز وفق سياسته.
---

# التعديلات والإلغاءات

## تحديث بيانات الضيوف

```bash
curl -s -X PATCH "$API/v1/bookings/$REF/guests" \
  -H "$H" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "guests": [
      {
        "cabin": 0,
        "first_name": "Emma",
        "last_name": "Clarke",
        "lead": true,
        "nationality": "GB",
        "date_of_birth": "1985-04-02",
        "passport_number": "…"
      }
    ]
  }'
```

يستبدل هذا الطلب قائمة الضيوف كاملة.

يُسمح بالتحديث حتى الموعد النهائي لبيانات الضيوف، وهو ٧ أيام قبل الصعود افتراضيًا.

## تعديل الحجز: احسب السعر ثم طبّق التغيير

### ١. احسب سعر التعديل

أرسل `sailing_id` لموعد إبحار آخر، أو القائمة الجديدة الكاملة للحقل `cabins`، أو كليهما.

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendment-quotes" \
  -H "$H" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "sailing_id": "'$OTHER'"
  }'
```

تتضمن الاستجابة عرض السعر الجديد، وفرق السعر، ورسوم التعديل وفق سياسة الحجز، وأنواع التغييرات:

- `date`: التاريخ.
- `category`: فئة الكابينة.
- `occupancy`: أعداد النزلاء.
- `cabins`: الكبائن.

### ٢. طبّق التعديل

أرسل رقم نسخة الحجز التي تعدّلها في الترويسة `If-Match`.

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendments" \
  -H "$H" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'If-Match: "1"' \
  -H 'Content-Type: application/json' \
  -d '{
    "amendment_quote_id": "'$AMENDMENT_QUOTE'"
  }'
```

إذا تغيّر الحجز منذ قراءته، تُعاد الاستجابة `409 REVISION_CHANGED`. اقرأ الحجز مجددًا، ثم أعد حساب التعديل وتطبيقه على النسخة الحالية.

عند نجاح العملية، تُحرَّر الكبائن القديمة وتُحجز الجديدة في خطوة واحدة، ويزيد رقم نسخة الحجز بمقدار واحد.

## إلغاء الحجز

```bash
curl -s -X POST "$API/v1/bookings/$REF/cancel" \
  -H "$H" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "reason": "Guest cancelled"
  }'
```

تعرض الاستجابة رسوم الإلغاء المحتسبة وفق السياسة الأصلية للحجز، وبحسب عدد الأيام المتبقية قبل الصعود، اعتمادًا على تاريخ القاهرة.

وتعود الكبائن إلى البيع فورًا.
