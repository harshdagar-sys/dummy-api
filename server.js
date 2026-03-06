const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

app.get("/products", (req, res) => {

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;

  const filePath = path.join(__dirname, "products_converted.json");

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).json({ message: "Error reading file" });
    }

    const products = JSON.parse(data);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    const paginatedData = products.slice(startIndex, endIndex);

    res.json({
      page,
      limit,
      totalRecords: products.length,
      totalPages: Math.ceil(products.length / limit),
      data: paginatedData
    });

  });

});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});