# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.







تقرير حالة نظام Smart Dorm Wallet
بناءً على الفحص الشامل للواجهة الأمامية (Frontend) والواجهة الخلفية (Backend)، إليك تقرير مفصل بالمشاكل الحالية التي تواجهها، والواجهات (الشاشات) الناقصة التي تحتاج إلى بناء لكي يكتمل النظام.

🔴 أولاً: المشاكل البرمجية الحالية (Bugs)
لقد قمت بفحص المشاكل التي ذكرتها في رسالتك الأخيرة، ووجدت أسبابها الدقيقة:

مشكلة عدم ظهور صورة الإيصال عند المشرف:

السبب: في شاشة PendingDeposits.jsx، يقوم النظام بجلب الرابط الآمن للصورة من الخادم. الخادم يعيد الرابط في متغير اسمه signedUrl، ولكن الواجهة الأمامية تحاول قراءته من متغير اسمه url (غير موجود)، مما يؤدي إلى عدم عرض الصورة.
الحل: تعديل الكود في الواجهة الأمامية ليقرأ urlData?.signedUrl بدلاً من urlData?.url.
مشكلة خطأ 422 (بيانات غير صحيحة) عند اعتماد الإيداع:

السبب: عندما يقوم المشرف باعتماد الإيداع، يقوم النظام بتسجيل العملية في "الدفتر المالي" (Ledger/Transaction). يتم إرسال نوع المرجع بالاسم 'DepositRequest' (بحرف D كبير)، ولكن قاعدة البيانات (Schema) صارمة وتقبل فقط الاسم 'depositRequest' (بحرف d صغير). هذا الاختلاف البسيط في حالة الأحرف يرفضه النظام ويعتبره "نوع مرجع غير صحيح".
الحل: تعديل ملف depositService.js لإرسال القيمة المطابقة لقاعدة البيانات بالضبط.
🟡 ثانياً: الواجهات (الشاشات) الناقصة في النظام
بالنظر إلى ملف التوجيهات الأساسي App.jsx وملفات المشروع، تم اكتشاف أن بعض الشاشات المهمة غير موجودة أو غير مربوطة في النظام حتى الآن:

1. واجهات خاصة بالمشرف (Admin)
شاشة إدارة النزاعات (Disputes Management):
توجد إحصائية في لوحة تحكم المشرف وزر "نزاعات نشطة" يوجه إلى مسار /admin/disputes، ولكن لا توجد شاشة مبرمجة لهذا المسار. إذا نقر المشرف على الزر حالياً سيتم إعادة توجيهه للشاشة الرئيسية.
شاشة إنشاء/إدارة المصروفات المشتركة (Shared Expenses Admin):
الواجهة الخلفية تدعم مسار إنشاء المصروفات المشتركة وتوزيعها على الطلاب (POST /api/v1/expenses)، ولكن لا توجد أي شاشة في لوحة المشرف لإدخال هذه المصروفات وتحديد الطلاب المعنيين.
شاشة إدارة التجار (Merchants Management):
الواجهة الخلفية تدعم نظام التجار (إضافة تاجر، تسجيل مشتريات، تصفية حساب تاجر)، ولكن لا توجد واجهة للمشرف لإدارة هذا النظام (لا يوجد /admin/merchants).
شاشة إعدادات النظام المتقدمة (System Settings):
الواجهة الحالية تتيح للمشرف تفعيل وإلغاء "وضع الصيانة" فقط، ولكن لا توجد شاشة لضبط الإعدادات المالية المهمة مثل (رسوم السحب withdrawalFeeValue، والحد الأقصى للدين maxDebtPerUser).
2. واجهات خاصة بالطالب (Resident)
شاشة الملف الشخصي (Profile / Settings):
لا توجد شاشة تتيح للطالب عرض بيانات ملفه الشخصي أو تغيير كلمة المرور أو إعدادات حسابه.
شاشة الدفع للتجار (Merchant Purchase):
الواجهة الخلفية تدعم الشراء من التجار النشطين من خلال مسح كود QR أو اختيار التاجر، لكن لا توجد واجهة للمستخدم لإتمام عملية الدفع.
🟢 ثالثاً: خطة العمل المقترحة
أقترح أن نبدأ بالترتيب التالي:

IMPORTANT

الخطوة 1: إصلاح الأخطاء الحرجة الحالية فوراً (Bugs Fixes)

إصلاح مشكلة عدم ظهور صورة الإيصال للمشرف.
إصلاح مشكلة الـ 422 عند الموافقة على الإيداع.
TIP

الخطوة 2: إضافة الشاشات الأساسية المفقودة للمشرف

برمجة شاشة "إدارة النزاعات" ليتمكن المشرف من حل النزاعات المرفوعة من الطلاب.
برمجة شاشة "المصروفات المشتركة" لكي يتمكن المشرف من تسجيل مصاريف السكن (مثل الكهرباء والماء) وخصمها من الطلاب.
NOTE

الخطوة 3: إضافة شاشات التجار والإعدادات (اختياري / مرحلة لاحقة)

برمجة شاشة التجار.
برمجة شاشة إعدادات النظام وتعديل سقف الديون.