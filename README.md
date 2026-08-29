# Miraware Voice Medical Input

مكوّن إدخال صوتي عربي (jQuery plugin) مع تصحيح إملائي محلي وتحسينات مخصصة
للنصوص الطبية. مبني ليكون قابل للتركيب داخل أي صفحة، مو مربوط بـ IDs ثابتة.

## تشغيل الـ Demo
- افتح `index.html` مباشرة في المتصفح (Chrome أو Edge، لأنهم يدعمون Web Speech API).
- ما فيه أي اعتماد على إنترنت لتشغيل الصفحة: jQuery والقاموس العربي محليين
  بالكامل تحت `vendor/`.
- بعد الضغط على "تجهيز للإرسال" رح تشوف الـ payload الفعلي (JSON) بلوحة تحت الزر
  — هذا فقط توضيح، المكوّن نفسه ما يخزّن ولا يرسل أي شي بمفرده.

## الاستخدام كمكوّن داخل صفحتك

```html
<link rel="stylesheet" href="./styles.css">
<script src="./vendor/jquery/jquery.min.js"></script>
<script src="./app.js"></script>

<div class="mmf-card mmf-root" id="my-form">
  <div class="mmf-field">
    <label class="mmf-label" for="symptom">الأعراض</label>
    <div class="mmf-input-wrap">
      <input class="mmf-input" id="symptom" type="text">
      <button class="mmf-mic-btn" type="button" data-target="#symptom">...</button>
    </div>
  </div>
  <div class="mmf-actions">
    <button id="prepare-btn" class="mmf-btn mmf-btn-primary mmf-prepare-btn" type="button">
      تجهيز للإرسال
    </button>
  </div>
  <p class="mmf-status" aria-live="polite"></p>
</div>

<script>
  $('#my-form').voiceMedicalForm({
    onPrepare: function (payload) {
      // payload.values -> array بكل قيم الحقول بنفس الترتيب اللي بالـ DOM
      console.log(payload);
    }
  });

  // أو استماع للحدث بدل الـ callback:
  document.getElementById('my-form').addEventListener('mmf:prepare', function (e) {
    console.log(e.detail);
  });
</script>
```

المكوّن يبني هيكله من أي عنصر جذر فيه `.mmf-root` مع حقول `.mmf-input` وأزرار
`.mmf-mic-btn` وزر تجهيز يطابق `.mmf-prepare-btn`/`#prepare-btn` وعنصر حالة
`.mmf-status` — بدون افتراض IDs معينة لعدد أو ترتيب الحقول.

## خيارات `voiceMedicalForm(options)`
| الخيار | الافتراضي | الوصف |
|---|---|---|
| `recognitionLangs` | `['ar-SA','ar-EG','ar']` | لغات التعرف الصوتي، بيتنقل بينها تلقائيًا لو لغة مو مدعومة |
| `maxRecordingMs` | `7000` | إيقاف تلقائي للتسجيل بعد هالمدة |
| `maxAlternatives` | `5` | عدد البدائل اللي ياخذها التعرف الصوتي بعين الاعتبار لكل نتيجة |
| `phraseHints` | `[]` | كلمات/عبارات طبية لتحسين دقة التعرف (لو المتصفح يدعمها) |
| `aggressiveTaaFix` | `false` | تفعيل تفضيل التاء المربوطة (ة) على الهاء (ه) لما القاموس يقبل الاثنين |
| `onPrepare` / `onSave` | `null` | callback يستدعى بعد "تجهيز للإرسال"، `onSave` قديم ومدعوم للتوافق |

## الأحداث
- `mmf:prepare` — الحدث الأساسي، يُطلق بعد الضغط على زر التجهيز.
- `mmf:save` — alias قديم لنفس الحدث، للتوافق مع تكاملات سابقة.

كلا الحدثين يحملان نفس الـ payload:
```js
{
  values: ['نص الحقل الأول', 'نص الحقل الثاني', '...'],
  firstValue: 'نص الحقل الأول',   // للتوافق مع كود قديم افترض حقلين بس
  secondValue: 'نص الحقل الثاني',
  raw: { first: '...', second: '...' }
}
```

## بدون تخزين أو شبكة
المكوّن ما يستخدم `localStorage`/`sessionStorage` ولا يرسل أي طلب شبكة بنفسه.
كل اللي يسويه زر "تجهيز للإرسال" هو تصحيح النص وبناء الـ payload وتمريره
للصفحة المستضيفة عبر callback/حدث — القرار شو تسوي بالنص (submit، API call، ...)
براجع للصفحة المستضيفة بالكامل.

## القاموس المحلي
`vendor/dicts/ar.aff` و`ar.dic` بصيغة Hunspell. لو مكتبة `Typo.js` محمّلة
بالصفحة يستخدمها المكوّن مباشرة، وإلا يستخدم محرك بديل خفيف مبني محليًا
(`createLocalDictionaryEngine`) بنفس واجهة `check`/`suggest`.

## مصطلحات طبية (لمشاريع مراكز طبية)
بما إن المشروع موجّه لمركز طبي، فيه قائمتين بـ `app.js` مصممتين ليتم
توسيعهم بسهولة:
- `MEDICAL_SEED_WORDS` — كلمات طبية (تخصصات، أعراض، تشخيصات) تُضاف كـ
  "صحيحة دائمًا" حتى لو القاموس العربي العام ما يعرفها، عشان ما ينعمل لها
  تصحيح خاطئ.
- `SAFE_REPLACEMENTS` — يحتوي على تصحيحات شائعة لأخطاء نطق مصطلحات نسبة
  طبية (زي "جراحيه" ← "جراحية") ما تغطيها قواعد القاموس العامة.

لإضافة مصطلحات مركزكم الخاصة (أسماء أقسام، أدوية شائعة، تشخيصات متكررة)،
زيدوا عليهم مباشرة بنفس النمط الموجود.

**تنويه:** بعض الكلمات متشابهة لفظيًا مع كلمات عربية أخرى صحيحة تمامًا
(مثلاً "عامه" = "سنته" مقابل "عامة" = "عام/شامل") — هذا النوع ما ينحل
بقائمة استبدال عامة لأنه يعتمد على سياق الجملة، فبيضل نادرًا ما يحتاج
تدقيق يدوي.

## الاختبار
- اختبار آلي (jsdom) موجود يغطي: بنية RTL، عدم تكرار IDs، تحميل القاموس،
  التصحيح مع الترقيم، دورة المايك (تشغيل/إيقاف)، وزر التجهيز. هذا بديل عن
  اختبار متصفح حقيقي غير متوفر ببيئة التطوير.
- **لسا لازم اختبار يدوي حقيقي** بمتصفح Chrome/Edge مع مايكروفون فعلي، لأن
  دقة التعرف الصوتي الفعلية ما ينعمل لها محاكاة كاملة آليًا.

راجع `TODO.md` لتفاصيل كل خطوة والحالة الحالية.
