import { useDevices } from '@/devices/hub';
import { DevicesList } from '@/screens/DevicesList';
import { Welcome } from '@/screens/Welcome';

export default function Home() {
  const { devices, loaded } = useDevices();
  if (!loaded) return null;
  return devices.length ? <DevicesList devices={devices} /> : <Welcome />;
}
