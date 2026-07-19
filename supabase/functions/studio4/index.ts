// Portal de miembros The Studio 4 — auth propia + calendario + planes.
// Schema studio4 (NO expuesto en PostgREST): acceso por SQL directo con SUPABASE_DB_URL.
import postgres from "npm:postgres@3.4.5";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_STUDIO4_KEY") ?? "";
const OTP_FROM =
  Deno.env.get("STUDIO4_OTP_FROM") ?? "The Studio 4 <no-reply@thestudio4.io>";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  max: 2,
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---------- crypto ----------
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    key,
    256,
  );
  return `${b64(salt.buffer as ArrayBuffer)}:${b64(bits)}`;
}
async function verifyPassword(password: string, stored: string) {
  const [salt] = stored.split(":");
  return (await hashPassword(password, salt)) === stored;
}
async function sha256(s: string) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function hmac(data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SERVICE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, enc.encode(data)),
      ),
    ),
  );
}
async function makeToken(memberId: string, email: string) {
  const payload = b64url(
    JSON.stringify({ sub: memberId, email, exp: Date.now() + 30 * 864e5 }),
  );
  return `${payload}.${await hmac(payload)}`;
}
async function readToken(
  req: Request,
): Promise<{ sub: string; email: string } | null> {
  const token = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await hmac(payload)) !== sig) return null;
  const data = JSON.parse(unb64url(payload));
  if (data.exp < Date.now()) return null;
  return data;
}

// ---------- helpers ----------
async function getMember(id: string) {
  const rows =
    await sql`select id, email, nombre, telefono, tipo, plan_code, plan_activo, created_at
    from studio4.members where id = ${id}`;
  return rows[0] ?? null;
}
async function monthUsage(memberId: string) {
  const reservas =
    await sql`select fecha, hora_inicio, hora_fin, tipo from studio4.bookings
    where member_id = ${memberId} and fecha >= date_trunc('month', current_date)
    and fecha < date_trunc('month', current_date) + interval '1 month' order by fecha`;
  const usadas = reservas
    .filter((b) => b.tipo === "plan")
    .reduce((s, b) => s + (b.hora_fin - b.hora_inicio), 0);
  return { usadas, reservas };
}
// 'admin' (Vitto) puede todo; 'staff' (Emely) gestiona reservas y ve miembros
async function adminRole(pin: string): Promise<"admin" | "staff" | null> {
  const rows =
    await sql`select key, value from studio4.settings where key in ('admin_pin') or key like 'staff_pin_%'`;
  const hit = rows.find((r) => r.value === String(pin));
  if (!hit) return null;
  return hit.key === "admin_pin" ? "admin" : "staff";
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const action = String(body.action ?? "");

  try {
    // ---------- público ----------
    if (action === "plans") {
      const plans =
        await sql`select code, nombre, precio, horas_mes, extra_rate, payment_link, categoria
        from studio4.plans where activo order by precio`;
      return json({ plans });
    }

    if (action === "signup") {
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      const password = String(body.password ?? "");
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
        return json(
          { error: "Correo inválido o clave menor a 8 caracteres" },
          400,
        );
      }
      const dup =
        await sql`select 1 from studio4.members where lower(email) = ${email}`;
      if (dup.length) return json({ error: "Ese correo ya tiene cuenta" }, 409);
      const hash = await hashPassword(password);
      const nombre = String(body.nombre ?? "").slice(0, 120) || null;
      const telefono = String(body.telefono ?? "").slice(0, 30) || null;
      const tipo = body.tipo === "marca" ? "marca" : "fotografo";
      const rows =
        await sql`insert into studio4.members (email, password_hash, nombre, telefono, tipo)
        values (${email}, ${hash}, ${nombre}, ${telefono}, ${tipo}) returning id, email`;
      return json({ token: await makeToken(rows[0].id, rows[0].email) });
    }

    if (action === "login") {
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      const rows =
        await sql`select id, email, password_hash from studio4.members where lower(email) = ${email}`;
      if (
        !rows.length ||
        !(await verifyPassword(
          String(body.password ?? ""),
          rows[0].password_hash,
        ))
      ) {
        return json({ error: "Correo o clave incorrectos" }, 401);
      }
      return json({ token: await makeToken(rows[0].id, rows[0].email) });
    }

    if (action === "otp_request") {
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      const member =
        await sql`select 1 from studio4.members where lower(email) = ${email}`;
      // Respuesta idéntica exista o no la cuenta (no filtrar correos registrados)
      if (member.length) {
        if (!RESEND_KEY)
          return json(
            {
              error:
                "Recuperación por correo aún no disponible. Escríbenos por WhatsApp.",
            },
            503,
          );
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const codeHash = await sha256(code);
        await sql`insert into studio4.otp_codes (email, code_hash, expires_at)
          values (${email}, ${codeHash}, now() + interval '10 minutes')`;
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: OTP_FROM,
            to: [email],
            subject: `Tu código The Studio 4: ${code}`,
            html: `<div style="font-family:sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #ddd"><h2 style="letter-spacing:2px">THE STUDIO 4</h2><p>Tu código para restablecer la clave:</p><p style="font-size:34px;font-weight:800;letter-spacing:8px">${code}</p><p style="color:#666;font-size:12px">Vence en 10 minutos. Si no lo pediste, ignora este correo.</p></div>`,
          }),
        });
        if (!r.ok) return json({ error: "No se pudo enviar el correo" }, 502);
      }
      return json({ ok: true });
    }

    if (action === "otp_verify") {
      const email = String(body.email ?? "")
        .trim()
        .toLowerCase();
      const newPassword = String(body.new_password ?? "");
      if (newPassword.length < 8)
        return json({ error: "Clave menor a 8 caracteres" }, 400);
      const codeHash = await sha256(String(body.code ?? ""));
      const otp = await sql`select id from studio4.otp_codes
        where email = ${email} and code_hash = ${codeHash} and not used and expires_at > now()
        order by created_at desc limit 1`;
      if (!otp.length) return json({ error: "Código inválido o vencido" }, 401);
      const hash = await hashPassword(newPassword);
      await sql`update studio4.otp_codes set used = true where id = ${otp[0].id}`;
      await sql`update studio4.members set password_hash = ${hash} where lower(email) = ${email}`;
      return json({ ok: true });
    }

    // ---------- admin (PIN) ----------
    if (action.startsWith("admin_")) {
      const role = await adminRole(String(body.pin ?? ""));
      if (!role) return json({ error: "PIN incorrecto" }, 401);
      const soloAdmin = ["admin_set_plan"];
      if (role === "staff" && soloAdmin.includes(action)) {
        return json({ error: "Solo el administrador puede asignar planes" }, 403);
      }

      if (action === "admin_list_members") {
        const members =
          await sql`select id, email, nombre, telefono, plan_code, plan_activo, created_at
          from studio4.members order by created_at`;
        return json({ members });
      }
      if (action === "admin_set_plan") {
        const email = String(body.email ?? "").toLowerCase();
        const plan = body.plan_code ? String(body.plan_code) : null;
        const activo = !!body.plan_activo;
        const r =
          await sql`update studio4.members set plan_code = ${plan}, plan_activo = ${activo}
          where lower(email) = ${email} returning id`;
        return r.length
          ? json({ ok: true })
          : json({ error: "Miembro no encontrado" }, 404);
      }
      if (action === "admin_add_booking") {
        let memberId: string | null = null;
        if (body.email) {
          const m =
            await sql`select id from studio4.members where lower(email) = ${String(body.email).toLowerCase()}`;
          if (!m.length) return json({ error: "Miembro no encontrado" }, 404);
          memberId = m[0].id;
        }
        const fecha = String(body.fecha ?? "");
        if (!isDate(fecha)) return json({ error: "Fecha inválida" }, 400);
        const tipo = memberId ? String(body.tipo ?? "plan") : "externo";
        const nota = String(body.nota ?? "").slice(0, 200) || null;
        await sql`insert into studio4.bookings (member_id, fecha, hora_inicio, hora_fin, tipo, nota)
          values (${memberId}, ${fecha}, ${Number(body.hora_inicio)}, ${Number(body.hora_fin)}, ${tipo}, ${nota})`;
        return json({ ok: true });
      }
      if (action === "admin_del_booking") {
        await sql`delete from studio4.bookings where id = ${String(body.id)}`;
        return json({ ok: true });
      }
      if (action === "admin_day") {
        const fecha = String(body.fecha ?? "");
        if (!isDate(fecha)) return json({ error: "Fecha inválida" }, 400);
        const bookings =
          await sql`select b.id, b.fecha, b.hora_inicio, b.hora_fin, b.tipo, b.nota,
            m.email, m.nombre
          from studio4.bookings b left join studio4.members m on m.id = b.member_id
          where b.fecha = ${fecha} order by b.hora_inicio`;
        return json({ bookings });
      }
      if (action === "admin_requests") {
        const requests =
          await sql`select r.id, r.plan_actual, r.plan_nuevo, r.estado, r.created_at,
            m.email, m.nombre
          from studio4.plan_change_requests r join studio4.members m on m.id = r.member_id
          where r.estado = 'pendiente' order by r.created_at`;
        return json({ requests });
      }
      return json({ error: "Acción admin desconocida" }, 400);
    }

    // ---------- autenticado ----------
    const session = await readToken(req);
    if (!session) return json({ error: "Sesión inválida" }, 401);

    if (action === "me") {
      const member = await getMember(session.sub);
      if (!member) return json({ error: "Cuenta no encontrada" }, 404);
      const planRows = member.plan_code
        ? await sql`select code, nombre, precio, horas_mes, extra_rate, payment_link from studio4.plans where code = ${member.plan_code}`
        : [];
      const plan = planRows[0] ?? null;
      const { usadas, reservas } = await monthUsage(member.id);
      const solicitudes =
        await sql`select plan_nuevo, estado, created_at from studio4.plan_change_requests
        where member_id = ${member.id} and estado = 'pendiente'`;
      return json({
        member,
        plan,
        usadas,
        disponibles: plan ? Math.max(0, Number(plan.horas_mes) - usadas) : 0,
        reservas,
        solicitudes,
      });
    }

    if (action === "calendar") {
      const desde = String(body.desde ?? "");
      const hasta = String(body.hasta ?? "");
      if (!isDate(desde) || !isDate(hasta))
        return json({ error: "Rango inválido" }, 400);
      const rows =
        await sql`select fecha, hora_inicio, hora_fin, member_id from studio4.bookings
        where fecha between ${desde} and ${hasta} order by fecha`;
      // Anónimo: solo fecha/horas; 'mine' marca las del propio miembro
      const slots = rows.map((b) => ({
        fecha: b.fecha,
        hora_inicio: b.hora_inicio,
        hora_fin: b.hora_fin,
        mine: b.member_id === session.sub,
      }));
      return json({ slots });
    }

    if (action === "request_plan_change") {
      const member = await getMember(session.sub);
      const planNuevo = String(body.plan_nuevo ?? "");
      const p =
        await sql`select code, categoria from studio4.plans where code = ${planNuevo} and activo`;
      if (!p.length) return json({ error: "Plan inválido" }, 400);
      const catRequerida = member?.tipo === "marca" ? "brand" : "foto";
      if (p[0].categoria !== catRequerida) {
        return json({ error: "Ese plan no aplica para tu tipo de cuenta. Escríbenos por WhatsApp si quieres cambiarlo." }, 403);
      }
      await sql`insert into studio4.plan_change_requests (member_id, plan_actual, plan_nuevo)
        values (${session.sub}, ${member?.plan_code ?? null}, ${planNuevo})`;
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    console.error("studio4 error:", e);
    return json({ error: "Error interno" }, 500);
  }
});
