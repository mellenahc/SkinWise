import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const db=new PrismaClient();
const products=[
{name:'Daily Hydrating Cleanser',brand:'SkinWise Demo',category:'Cleanser',barcode:'000000000001',ingredients:['Water','Glycerin','Ceramide NP']},
{name:'Brightening Serum',brand:'SkinWise Demo',category:'Serum',barcode:'000000000002',ingredients:['Water','Niacinamide','Glycerin']},
{name:'Clarifying Treatment',brand:'SkinWise Demo',category:'Treatment',barcode:'000000000003',ingredients:['Water','Salicylic Acid','Denatured Alcohol','Fragrance']},
{name:'Barrier Moisturizer',brand:'SkinWise Demo',category:'Moisturizer',barcode:'000000000004',ingredients:['Water','Glycerin','Squalane','Ceramide NP']},
{name:'Evening Renewal',brand:'SkinWise Demo',category:'Treatment',barcode:'000000000005',ingredients:['Water','Retinol','Squalane']}
];
for(const p of products)await db.product.upsert({where:{barcode:p.barcode},update:p,create:p});
console.log('Seeded',products.length,'demo products');await db.$disconnect();
