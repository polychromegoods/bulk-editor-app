import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Seed the initial promo code
  const code = await prisma.promoCode.upsert({
    where: { code: "BULKPRO2026" },
    update: {},
    create: {
      code: "BULKPRO2026",
      plan: "premium",       // grants Premium Pro access
      durationDays: 365,     // 1 year
      maxUses: 100,          // up to 100 redemptions
      usedCount: 0,
      active: true,
    },
  });
  console.log("Promo code seeded:", code);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
