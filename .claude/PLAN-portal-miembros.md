# Plan — Portal de Miembros The Studio 4 (2026-07-19)

## Decisiones (aprobadas por Vitto)

- Backend: Supabase `atxmxihxboswsewdbdgz` (compartido con app1bite/ERP), **schema `studio4` aislado**, acceso SOLO vía edge function (schema no expuesto en PostgREST, RLS on sin policies).
- Auth: custom en la edge function (email+password PBKDF2, token HMAC firmado con service role key) — NO se toca Supabase Auth compartido (SMTP info@1bite.studio es del proyecto entero).
- OTP recuperación: edge function + Resend key `RESEND_STUDIO4_KEY` de un **team Resend NUEVO con el correo de The Studio 4** (pendiente crear cuenta + verificar dominio thestudio4.io — DNS Namecheap).
- Stripe: cuenta existente de Vitto. Suscripciones por Payment Links guardados en `studio4.plans.payment_link`.
- Frontend: SPA estática en `/app/` del mismo repo GitHub Pages + `/app/admin.html` (PIN).

## Pasos

1. [x] Migración schema `studio4`: plans (seed escalera final), members, bookings, otp_codes, plan_change_requests, settings (admin_pin).
2. [x] Edge function `studio4` (router: signup/login/me/calendar/request*plan_change/otp_request/otp_verify/admin*\*) deploy con `--no-verify-jwt`.
3. [x] SPA `/app/index.html`: login/registro/recuperar, saldo de horas del plan, calendario disponibilidad (reservas anónimas), gestión/cambio de plan, botón de pago Stripe.
4. [x] `/app/admin.html`: cargar reservas, asignar planes, ver día.
5. [x] Commit + push (GitHub Pages publica).
6. [x] (curl plans/signup/me/calendar + Playwright login/calendario OK; /app en prod verificándose) Verificar en prod con curl + navegador.

## Pendiente de Vitto

- Crear cuenta Resend con correo del Studio → verificar dominio thestudio4.io → `supabase secrets set RESEND_STUDIO4_KEY`.
- Crear 6 productos/prices subscription en Stripe → pegar Payment Links en `studio4.plans.payment_link`.

## Criterio de éxito

- Registro + login + ver saldo funcionan en thestudio4.io/app contra prod.
- Calendario muestra ocupado/libre sin exponer identidad.
- app1bite y ERP intactos (schema aparte, sin cambios en Auth/config compartida).
