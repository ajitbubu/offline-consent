/**
 * Development seed: a purpose catalogue, one published notice version standing
 * in for a printed paper form, and a first administrator.
 *
 * Idempotent - safe to re-run. The administrator is created only when the staff
 * table is empty, so re-seeding never silently resets a password.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

const PURPOSES = [
  {
    code: "newsletter",
    name: "Newsletter and updates",
    description:
      "Sending you our newsletter and occasional updates about our work by email.",
    data_categories: ["Name", "Email address"],
    display_order: 1,
  },
  {
    code: "promotional_sms",
    name: "Promotional SMS and calls",
    description:
      "Contacting you by SMS or telephone about offers, events and membership renewals.",
    data_categories: ["Name", "Mobile number"],
    display_order: 2,
  },
  {
    code: "event_photography",
    name: "Event photography",
    description:
      "Publishing photographs taken at our events, including in our reports and on our website.",
    data_categories: ["Photographs", "Name"],
    display_order: 3,
  },
  {
    code: "partner_offers",
    name: "Sharing with partner organisations",
    description:
      "Sharing your contact details with our partner organisations so they can contact you about their offers.",
    data_categories: ["Name", "Email address", "Mobile number"],
    display_order: 4,
  },
  {
    code: "research",
    name: "Research and statistics",
    description:
      "Using your details in aggregated research and statistics about our membership.",
    data_categories: ["Age band", "District", "Membership category"],
    display_order: 5,
  },
];

const NOTICE = {
  code: "membership-form",
  version: 3,
  language: "en",
  form_label: "Membership Application Form (Rev. 3, 2019)",
  title: "Notice under section 5, Digital Personal Data Protection Act 2023",
  fiduciary_contact:
    "Data Protection Officer, Example Society, Bengaluru. dpo@example.org",
  body: [
    "We collect the personal data you provide on this form in order to administer your membership and, where you have given consent, for the additional purposes listed below.",
    "",
    "You may withdraw your consent for any of these purposes at any time, and doing so is as easy as giving it. Withdrawing consent does not affect the lawfulness of anything we did with your data before you withdrew it.",
    "",
    "You have the right to access a summary of your personal data, to seek correction or erasure, to nominate another person to exercise your rights, and to raise a grievance with us before approaching the Data Protection Board of India.",
  ].join("\n"),
  purposes: {
    newsletter: "I agree to receive the newsletter by email",
    promotional_sms: "I agree to receive offers by SMS and telephone",
    event_photography: "I agree to the publication of photographs taken at events",
    partner_offers: "I agree that my details may be shared with partner organisations",
    research: "I agree to my details being used in aggregated research",
  },
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");

    for (const p of PURPOSES) {
      await client.query(
        `INSERT INTO purpose (code, name, description, data_categories, display_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description,
               data_categories = EXCLUDED.data_categories,
               display_order = EXCLUDED.display_order`,
        [p.code, p.name, p.description, p.data_categories, p.display_order],
      );
    }

    const notice = await client.query(
      `INSERT INTO consent_notice
         (code, version, language, form_label, title, body, fiduciary_contact, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (code, version, language) DO UPDATE SET form_label = EXCLUDED.form_label
       RETURNING id`,
      [
        NOTICE.code,
        NOTICE.version,
        NOTICE.language,
        NOTICE.form_label,
        NOTICE.title,
        NOTICE.body,
        NOTICE.fiduciary_contact,
      ],
    );
    const noticeId = notice.rows[0].id;

    let order = 0;
    for (const [code, printedLabel] of Object.entries(NOTICE.purposes)) {
      order += 1;
      await client.query(
        `INSERT INTO consent_notice_purpose (notice_id, purpose_id, printed_label, display_order)
         VALUES ($1, (SELECT id FROM purpose WHERE code = $2), $3, $4)
         ON CONFLICT (notice_id, purpose_id) DO UPDATE
           SET printed_label = EXCLUDED.printed_label,
               display_order = EXCLUDED.display_order`,
        [noticeId, code, printedLabel, order],
      );
    }

    const { rows: staff } = await client.query("SELECT count(*)::int AS n FROM staff_user");
    let credentials = null;

    if (staff[0].n === 0) {
      const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.org").toLowerCase();
      const password =
        process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString("base64url");
      await client.query(
        `INSERT INTO staff_user (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'admin')`,
        [email, await bcrypt.hash(password, 12), "Seed Administrator"],
      );
      credentials = { email, password };
    }

    await client.query("COMMIT");

    console.log(`seeded ${PURPOSES.length} purposes`);
    console.log(`seeded notice ${NOTICE.code} v${NOTICE.version} (${NOTICE.language})`);
    if (credentials) {
      console.log("");
      console.log("  Administrator created - this password is shown once:");
      console.log(`    email:    ${credentials.email}`);
      console.log(`    password: ${credentials.password}`);
      console.log("");
    } else {
      console.log("staff_user already populated, administrator left untouched");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
