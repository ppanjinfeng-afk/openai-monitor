# Storefront Flow

This project now includes a customer-facing storefront flow for selling activation codes that deliver team invites.

## Public URLs

- `/shop`
  - Create orders
  - Query order status
  - See issued activation codes after payment confirmation
- `/activate`
  - Redeem an activation code
  - Send or resend the team invite to the target email
- `/store-admin`
  - Configure products
  - Manage orders and issued codes
  - Manually mark orders as paid
  - Reissue activation codes
  - Disable or restore activation codes
  - Resend team invites

## API Endpoints

- `GET /api/store/config`
- `GET /api/store/products`
- `POST /api/store/orders`
- `GET /api/store/orders/:orderNo`
- `POST /api/store/orders/:orderNo/mock-pay`
- `POST /api/store/payments/confirm`
- `POST /api/store/redeem`

Admin:

- `GET /api/store/admin/products`
- `POST /api/store/admin/products`
- `PUT /api/store/admin/products/:id`
- `GET /api/store/admin/orders`
- `GET /api/store/admin/orders/:orderNo`
- `POST /api/store/admin/orders/:orderNo/mark-paid`
- `POST /api/store/admin/orders/:orderNo/reissue-code`
- `POST /api/store/admin/codes/:code/resend-invite`
- `POST /api/store/admin/codes/:code/disable`
- `POST /api/store/admin/codes/:code/restore`

## Payment Confirmation Webhook

Use this endpoint after your payment gateway confirms a successful payment:

`POST /api/store/payments/confirm`

Headers:

- `Content-Type: application/json`
- `x-store-payment-secret: <STORE_PAYMENT_SECRET>`

Body example:

```json
{
  "orderNo": "ORD260418123456ABCD",
  "paymentReference": "trade-or-transaction-id"
}
```

Behavior:

1. Mark order as paid
2. Issue activation code automatically
3. Order query immediately shows the code

## Activation Flow

`POST /api/store/redeem`

```json
{
  "code": "CKD-ABCD-EFGH-JKLM",
  "email": "customer@example.com"
}
```

Behavior:

1. Validate the activation code
2. Detect whether the email is already a member
3. Reuse a pending invite if one already exists
4. Otherwise pick the best available synced workspace
5. Send the team invite
6. Mark the code as redeemed

## Environment Variables

- `PORT`
- `STORE_NAME`
- `STORE_NOTICE`
- `STORE_SUPPORT_EMAIL`
- `STORE_PAYMENT_SECRET`
- `STORE_ADMIN_SECRET`
- `STORE_ALLOW_MOCK_PAY`
- `NODE_ENV`

Recommended:

- Set `STORE_PAYMENT_SECRET` in production
- Set `STORE_ADMIN_SECRET` in production
- Set `STORE_ALLOW_MOCK_PAY=false` in production
- Set `NODE_ENV=production` in production

## Reverse Proxy Example

Point your domain to the local service port with Nginx or another reverse proxy.

Example:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Alipay / WeChat Next Step

The codebase now supports the business flow after payment confirmation.

You still need one of these for real production payments:

1. Direct official integration with Alipay / WeChat Pay
2. A payment bridge that receives official notifications and forwards successful orders to `/api/store/payments/confirm`

## Notes

- Store products are seeded in the database table `store_products`
- Default seeded product code: `team_monthly`
- Default seeded price: `199`
- Orders are stored in `store_orders`
- Activation codes are stored in `team_activation_codes`
