import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

async function main() {
  const code = await prisma.promoCode.upsert({
    where: { code: "BULKPRO2026" },
    update: {},
    create: {
      code: "BULKPRO2026",
      plan: "premium",
      durationDays: 365,
      maxUses: 100,
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
