using System.Runtime.CompilerServices;
class P{ [MethodImpl(MethodImplOptions.NoInlining)] static int Mul(int a,int b){int s=0;for(int i=0;i<b;i++)s+=a*i;return s;} static void Main(){System.Console.WriteLine(Mul(3,4));}}
