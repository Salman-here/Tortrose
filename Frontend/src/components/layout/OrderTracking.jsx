import React, { useState } from "react";
import { motion } from "framer-motion";
import { Home, Users, ShoppingCart, PieChart } from "lucide-react";

export default function AdminDashboardMVP() {
  const [kpis] = useState({ revenue: 48230, orders: 1281, customers: 932, conversion: 3.7 });

  const recentOrders = [
    { id: "#3421", name: "Aisha", amount: "$120", status: "Delivered" },
    { id: "#3420", name: "Bilal", amount: "$320", status: "Processing" },
    { id: "#3419", name: "Sara", amount: "$75", status: "Canceled" },
  ];

  const kpiCards = [
    { title: "Revenue", value: `$${kpis.revenue.toLocaleString()}`, icon: <Home size={18} />, color: 'hsl(150, 60%, 45%)' },
    { title: "Orders", value: kpis.orders, icon: <ShoppingCart size={18} />, color: 'hsl(220, 70%, 55%)' },
    { title: "Customers", value: kpis.customers, icon: <Users size={18} />, color: 'hsl(260, 60%, 55%)' },
    { title: "Conversion", value: `${kpis.conversion}%`, icon: <PieChart size={18} />, color: 'hsl(200, 80%, 50%)' },
  ];

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <h1 className="text-2xl font-extrabold tracking-tight mb-6" style={{ color: 'hsl(var(--foreground))' }}>Admin Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {kpiCards.map((card, i) => (
          <motion.div key={i} whileHover={{ y: -3 }} className="glass-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{card.title}</div>
                <div className="text-xl font-extrabold mt-1" style={{ color: 'hsl(var(--foreground))' }}>{card.value}</div>
              </div>
              <div className="glass-inner w-11 h-11 rounded-xl flex items-center justify-center" style={{ color: card.color }}>{card.icon}</div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="glass-panel overflow-hidden">
        <div className="p-4 sm:p-5" style={{ borderBottom: '1px solid var(--glass-border)' }}>
          <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Recent Orders</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--glass-border)' }}>
              {['Order ID', 'Customer', 'Amount', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentOrders.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-white/5" style={{ borderBottom: '1px solid var(--glass-border-subtle)' }}>
                <td className="px-4 py-3 font-medium" style={{ color: 'hsl(var(--foreground))' }}>{row.id}</td>
                <td className="px-4 py-3" style={{ color: 'hsl(var(--muted-foreground))' }}>{row.name}</td>
                <td className="px-4 py-3 font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{row.amount}</td>
                <td className="px-4 py-3"><StatusBadge>{row.status}</StatusBadge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ children }) {
  const styles = children === "Delivered"
    ? { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
    : children === "Processing"
      ? { bg: 'rgba(234, 179, 8, 0.12)', color: 'hsl(45, 93%, 40%)' }
      : { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' };
  return <span className="px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: styles.bg, color: styles.color }}>{children}</span>;
}
