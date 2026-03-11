import { Nav } from "./components/nav";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";
import { CodeExample } from "./components/code-example";
import { Pricing } from "./components/pricing";
import { Comparison } from "./components/comparison";
import { Cta } from "./components/cta";
import { Footer } from "./components/footer";

export default function Home() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <CodeExample />
        <Pricing />
        <Comparison />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
