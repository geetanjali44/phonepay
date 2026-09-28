require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const MERCHANT_UPI_ID =
  process.env.MERCHANT_UPI_ID;

const PAYEE_NAME =
  process.env.PAYEE_NAME || "CEZOO";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Supabase environment variables missing");
  process.exit(1);
}

if (!MERCHANT_UPI_ID) {
  console.error("MERCHANT_UPI_ID missing");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD missing");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);


/* ================================
   HEALTH
================================ */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CEZOO Payment Server Running"
  });
});


/* ================================
   CREATE PAYMENT
================================ */

app.post("/api/payment/create", async (req, res) => {

  try {

    const amount = Number(req.body.amount);
    const appName = String(req.body.app || "").toLowerCase();

    if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
      return res.status(400).json({
        error: "Invalid amount"
      });
    }

    if (!["phonepe", "paytm"].includes(appName)) {
      return res.status(400).json({
        error: "Invalid payment app"
      });
    }

    const paymentId =
      "CZ" +
      Date.now() +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    const deviceToken =
      crypto.randomUUID();

    const { error } = await supabase
      .from("upi_payments")
      .insert({
        payment_id: paymentId,
        device_token: deviceToken,
        amount: amount.toFixed(2),
        payment_app: appName,
        status: "pending"
      });

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Unable to create payment"
      });
    }

    const params =
      "pa=" + encodeURIComponent(MERCHANT_UPI_ID) +
      "&pn=" + encodeURIComponent(PAYEE_NAME) +
      "&tr=" + encodeURIComponent(paymentId) +
      "&tn=" + encodeURIComponent("CEZOO " + paymentId) +
      "&am=" + encodeURIComponent(amount.toFixed(2)) +
      "&cu=INR";

    let paymentUrl;

    if (appName === "phonepe") {

      paymentUrl =
        "intent://pay?" +
        params +
        "#Intent;" +
        "scheme=upi;" +
        "package=com.phonepe.app;" +
        "end";

    } else {

      /*
       Standard UPI URI.
       Paytm or another installed UPI handler
       may handle this depending on device.
      */

      paymentUrl =
        "upi://pay?" + params;
    }

    return res.json({
      success: true,
      paymentId,
      deviceToken,
      paymentUrl
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});


/* ================================
   CUSTOMER PAYMENT STATUS
================================ */

app.get("/api/payment/status/:paymentId", async (req, res) => {

  try {

    const paymentId = req.params.paymentId;
    const token = req.query.token;

    if (!paymentId || !token) {
      return res.status(400).json({
        error: "Missing payment credentials"
      });
    }

    const { data, error } = await supabase
      .from("upi_payments")
      .select(
        "payment_id,amount,payment_app,status,created_at,approved_at,rejected_at"
      )
      .eq("payment_id", paymentId)
      .eq("device_token", token)
      .maybeSingle();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Unable to check payment"
      });
    }

    if (!data) {
      return res.status(404).json({
        error: "Payment not found"
      });
    }

    return res.json({
      success: true,
      payment: data
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});


/* ================================
   ADMIN AUTH HELPER
================================ */

function checkAdmin(req, res, next) {

  const password =
    req.headers["x-admin-password"];

  if (!password || password !== ADMIN_PASSWORD) {

    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}


/* ================================
   ADMIN PAYMENTS
================================ */

app.get(
  "/api/admin/payments",
  checkAdmin,
  async (req, res) => {

    try {

      const { data, error } = await supabase
        .from("upi_payments")
        .select("*")
        .order("created_at", {
          ascending: false
        })
        .limit(200);

      if (error) {

        console.error(error);

        return res.status(500).json({
          error: "Unable to load payments"
        });
      }

      return res.json({
        success: true,
        payments: data || []
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        error: "Server error"
      });
    }
  }
);


/* ================================
   APPROVE
================================ */

app.post(
  "/api/admin/payment/:paymentId/approve",
  checkAdmin,
  async (req, res) => {

    try {

      const paymentId =
        req.params.paymentId;

      const { data, error } = await supabase
        .from("upi_payments")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
          rejected_at: null
        })
        .eq("payment_id", paymentId)
        .eq("status", "pending")
        .select()
        .maybeSingle();

      if (error) {

        console.error(error);

        return res.status(500).json({
          error: "Approval failed"
        });
      }

      if (!data) {
        return res.status(409).json({
          error: "Payment already processed or not found"
        });
      }

      return res.json({
        success: true,
        payment: data
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        error: "Server error"
      });
    }
  }
);


/* ================================
   REJECT
================================ */

app.post(
  "/api/admin/payment/:paymentId/reject",
  checkAdmin,
  async (req, res) => {

    try {

      const paymentId =
        req.params.paymentId;

      const { data, error } = await supabase
        .from("upi_payments")
        .update({
          status: "rejected",
          rejected_at: new Date().toISOString(),
          approved_at: null
        })
        .eq("payment_id", paymentId)
        .eq("status", "pending")
        .select()
        .maybeSingle();

      if (error) {

        console.error(error);

        return res.status(500).json({
          error: "Rejection failed"
        });
      }

      if (!data) {
        return res.status(409).json({
          error: "Payment already processed or not found"
        });
      }

      return res.json({
        success: true,
        payment: data
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        error: "Server error"
      });
    }
  }
);


app.listen(PORT, () => {
  console.log(`CEZOO payment server running on ${PORT}`);
});
