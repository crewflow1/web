export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white p-8">
      <h1 className="text-3xl font-bold">CrewFlow Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <h2 className="text-xl font-semibold">Jobs Today</h2>
          <p className="text-4xl mt-4 font-bold">12</p>
        </div>

        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <h2 className="text-xl font-semibold">Active Staff</h2>
          <p className="text-4xl mt-4 font-bold">8</p>
        </div>

        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <h2 className="text-xl font-semibold">AI Calls</h2>
          <p className="text-4xl mt-4 font-bold">24</p>
        </div>
      </div>
    </main>
  )
}